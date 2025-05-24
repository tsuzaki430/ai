import {
  type StandardSchemaV1,
  type Validator,
  type ToolCall,
  generateId as generateIdFunc,
  IdGenerator,
} from '@ai-sdk/provider-utils';
import {
  type UIMessage,
  type CreateUIMessage,
  type UIDataTypes,
} from '../ui-messages';
import { type ChatRequestOptions } from '../use-chat';
import {
  type ChatState,
  type InferUIDataParts,
  type UIDataPartSchemas,
} from './types';
import { updateToolCallResult } from '../update-tool-call-result';
import {
  isAssistantMessageWithCompletedToolCalls,
  shouldResubmitMessages,
} from '../should-resubmit-messages';
import { extractMaxToolInvocationStep } from '../extract-max-tool-invocation-step';
import { getToolInvocations } from '../get-tool-invocations';
import {
  createStreamingUIMessageState,
  processUIMessageStream,
  type StreamingUIMessageState,
} from '../process-ui-message-stream';
import { ChatTransport } from './chat-transport';
import { consumeStream } from '../../util/consume-stream';

type ExtendedCallOptions<
  MESSAGE_METADATA,
  DATA_TYPES extends UIDataTypes,
> = ChatRequestOptions & {
  onError?: (error: Error) => void;

  /**
Optional callback function that is invoked when a tool call is received.
Intended for automatic client-side tool execution.

You can optionally return a result for the tool call,
either synchronously or asynchronously.
   */
  onToolCall?: ({
    toolCall,
  }: {
    toolCall: ToolCall<string, unknown>;
  }) => void | Promise<unknown> | unknown;

  /**
   * Optional callback function that is called when the assistant message is finished streaming.
   *
   * @param message The message that was streamed.
   */
  onFinish?: (options: {
    message: UIMessage<MESSAGE_METADATA, DATA_TYPES>;
  }) => void;
};

/**
 * Enables network-related operations for a (TODO, link) `Chat`.
 */
export class ChatClient<
  MESSAGE_METADATA = unknown,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas = UIDataPartSchemas,
> {
  private generateId: IdGenerator;
  private transport: ChatTransport<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >;
  private maxSteps: number;
  private messageMetadataSchema:
    | Validator<MESSAGE_METADATA>
    | StandardSchemaV1<MESSAGE_METADATA>
    | undefined;
  private dataPartSchemas: UI_DATA_PART_SCHEMAS | undefined;

  private get lastMessage():
    | UIMessage<MESSAGE_METADATA, InferUIDataParts<UI_DATA_PART_SCHEMAS>>
    | undefined {
    return this.chat.messages[this.chat.messages.length - 1];
  }

  constructor(
    private chat: ChatState<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >,
    {
      generateId = generateIdFunc,
      transport,
      maxSteps = 1,
      messageMetadataSchema,
      dataPartSchemas,
    }: {
      generateId: IdGenerator;
      transport: ChatTransport<
        MESSAGE_METADATA,
        InferUIDataParts<UI_DATA_PART_SCHEMAS>
      >;
      maxSteps?: number;
      messageMetadataSchema?:
        | Validator<MESSAGE_METADATA>
        | StandardSchemaV1<MESSAGE_METADATA>;
      dataPartSchemas?: UI_DATA_PART_SCHEMAS;
    },
  ) {
    this.generateId = generateId;
    this.transport = transport;
    this.maxSteps = maxSteps;
    this.messageMetadataSchema = messageMetadataSchema;
    this.dataPartSchemas = dataPartSchemas;
  }

  removeAssistantResponse() {
    if (this.lastMessage == null) {
      throw new Error('Cannot remove assistant response from empty chat');
    }

    if (this.lastMessage.role !== 'assistant') {
      throw new Error('Last message is not an assistant message');
    }

    this.chat.popMessage();
  }

  async submitMessage({
    message,
    headers,
    body,
    onError,
    onToolCall,
    onFinish,
  }: ExtendedCallOptions<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  > & {
    message: CreateUIMessage<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >;
  }) {
    this.chat.pushMessage({
      ...message,
      id: message.id ?? this.generateId(),
    });
    await this.triggerRequest({
      headers,
      body,
      requestType: 'generate',
      onError,
      onToolCall,
      onFinish,
    });
  }

  async resubmitLastUserMessage({
    headers,
    body,
    onError,
    onToolCall,
    onFinish,
  }: ExtendedCallOptions<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >) {
    if (this.lastMessage === undefined) {
      return;
    }

    if (this.lastMessage?.role === 'assistant') {
      this.chat.popMessage();
    }

    return this.triggerRequest({
      requestType: 'generate',
      headers,
      body,
      onError,
      onToolCall,
      onFinish,
    });
  }

  async resumeStream({
    headers,
    body,
    onError,
    onToolCall,
    onFinish,
  }: ExtendedCallOptions<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >) {
    return this.triggerRequest({
      requestType: 'resume',
      headers,
      body,
      onError,
      onToolCall,
      onFinish,
    });
  }

  async addToolResult({
    toolCallId,
    result,
  }: {
    toolCallId: string;
    result: unknown;
  }) {
    this.chat.jobExecutor.run(async () => {
      updateToolCallResult({
        messages: this.chat.messages,
        toolCallId,
        toolResult: result,
      });

      // TODO: The above call is mutative, which maybe isn't the best pattern...
      // it would probably be better to have it just return the last message, modified,
      // so that we can replace the last message here instead. Much more efficient
      // and less footgun-y.
      this.chat.setMessages(this.chat.messages);

      // when the request is ongoing, the auto-submit will be triggered after the request is finished
      if (
        this.chat.status === 'submitted' ||
        this.chat.status === 'streaming'
      ) {
        return;
      }

      // auto-submit when all tool calls in the last assistant message have results:
      const lastMessage = this.chat.messages[this.chat.messages.length - 1];
      if (isAssistantMessageWithCompletedToolCalls(lastMessage)) {
        await this.triggerRequest({
          requestType: 'generate',
        });
      }
    });
  }

  async stopStream() {
    if (this.chat.status !== 'streaming' && this.chat.status !== 'submitted')
      return;

    if (this.chat.activeResponse?.abortController) {
      this.chat.activeResponse.abortController.abort();
      this.chat.activeResponse.abortController = undefined;
    }
  }

  private async triggerRequest({
    requestType,
    headers,
    body,
    onError,
    onToolCall,
    onFinish,
  }: ExtendedCallOptions<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  > & {
    requestType: 'generate' | 'resume';
  }) {
    this.chat.setStatus('submitted');

    const messageCount = this.chat.messages.length;
    const maxStep = extractMaxToolInvocationStep(
      getToolInvocations(this.lastMessage),
    );

    try {
      const activeResponse = {
        state: createStreamingUIMessageState({
          lastMessage: this.lastMessage,
          newMessageId: this.generateId(),
        }),
        abortController: new AbortController(),
      };

      this.chat.setActiveResponse(activeResponse);

      const stream = await this.transport.submitMessages({
        chatId: this.chat.id,
        messages: this.chat.messages,
        body,
        headers,
        abortController: activeResponse.abortController,
        requestType,
      });

      const runUpdateMessageJob = (
        job: (options: {
          state: StreamingUIMessageState<
            MESSAGE_METADATA,
            UI_DATA_PART_SCHEMAS
          >;
          write: () => void;
        }) => Promise<void>,
      ) =>
        // serialize the job execution to avoid race conditions:
        this.chat.jobExecutor.run(() =>
          job({
            state: activeResponse.state,
            write: () => {
              // streaming is set on first write (before it should be "submitted")
              this.chat.setStatus('streaming');

              const replaceLastMessage =
                this.lastMessage !== undefined &&
                activeResponse.state.message.id === this.lastMessage.id;

              if (replaceLastMessage) {
                this.chat.replaceMessage(
                  this.chat.messages.length - 1,
                  activeResponse.state.message,
                );
              } else {
                this.chat.pushMessage(activeResponse.state.message);
              }
            },
          }),
        );

      await consumeStream({
        stream: processUIMessageStream({
          stream,
          onToolCall,
          messageMetadataSchema: this.messageMetadataSchema,
          dataPartSchemas: this.dataPartSchemas,
          runUpdateMessageJob,
        }),
        onError: error => {
          throw error;
        },
      });

      onFinish?.({ message: activeResponse.state.message });

      this.chat.setStatus('ready');
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === 'AbortError') {
        this.chat.setStatus('ready');
        return null;
      }

      if (onError && err instanceof Error) {
        onError(err);
      }

      this.chat.setStatus('error', err as Error);
    } finally {
      this.chat.setActiveResponse(undefined);
    }

    // auto-submit when all tool calls in the last assistant message have results
    // and assistant has not answered yet
    if (
      shouldResubmitMessages({
        originalMaxToolInvocationStep: maxStep,
        originalMessageCount: messageCount,
        maxSteps: this.maxSteps,
        messages: this.chat.messages,
      })
    ) {
      await this.triggerRequest({
        requestType,
        onError,
        onToolCall,
        onFinish,
        headers,
        body,
      });
    }
  }
}
