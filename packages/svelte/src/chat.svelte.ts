import type { StandardSchemaV1, Validator } from '@ai-sdk/provider-utils';
import {
  convertFileListToFileUIParts,
  generateId,
  SerialJobExecutor,
  type ActiveResponse,
  type ChatRequestOptions,
  type ChatState,
  type ChatStatus,
  type CreateUIMessage,
  type IdGenerator,
  type InferUIDataParts,
  type UIDataTypes,
  type UIMessage,
  type UIDataPartSchemas,
  ChatClient,
  DefaultChatTransport,
  type CoreChatOptions,
  type ChatTransport,
} from 'ai';

class SvelteChatState<MESSAGE_METADATA, DATA_TYPES extends UIDataTypes>
  implements ChatState<MESSAGE_METADATA, DATA_TYPES>
{
  readonly id: string;
  messages: UIMessage<MESSAGE_METADATA, DATA_TYPES>[];
  status = $state<ChatStatus>('ready');
  error = $state<Error | undefined>(undefined);
  activeResponse: ActiveResponse<MESSAGE_METADATA> | undefined = undefined;
  jobExecutor = new SerialJobExecutor();

  constructor(
    id: string,
    messages?: UIMessage<MESSAGE_METADATA, DATA_TYPES>[],
  ) {
    this.id = id;
    this.messages = $state(messages ?? []);
  }

  setStatus = (status: ChatStatus, error?: Error) => {
    this.status = status;
    this.error = error;
  };

  setActiveResponse = (
    activeResponse: ActiveResponse<MESSAGE_METADATA> | undefined,
  ) => {
    this.activeResponse = activeResponse;
  };

  setMessages = (messages: UIMessage<MESSAGE_METADATA, DATA_TYPES>[]) => {
    this.messages = messages;
  };

  pushMessage = (message: UIMessage<MESSAGE_METADATA, DATA_TYPES>) => {
    this.messages.push(message);
  };

  popMessage = () => {
    this.messages.pop();
  };

  replaceMessage = (
    index: number,
    message: UIMessage<MESSAGE_METADATA, DATA_TYPES>,
  ) => {
    this.messages[index] = message;
  };
}

export type ChatOptions<
  MESSAGE_METADATA = unknown,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas = UIDataPartSchemas,
> = Omit<
  CoreChatOptions<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>,
  'chatId' | 'initialInput'
> & {
  /**
   * A unique ID for this chat. If not provided, a random ID will be generated.
   */
  id?: string;

  /**
   * Initial input of the chat.
   */
  input?: string;

  /**
   * Initial messages of the chat. Useful to load an existing chat history.
   */
  messages?: UIMessage<
    NoInfer<MESSAGE_METADATA>,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >[];

  transport?: ChatTransport<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >;

  maxSteps?: number;

  messageMetadataSchema?:
    | Validator<MESSAGE_METADATA>
    | StandardSchemaV1<MESSAGE_METADATA>;

  dataPartSchemas?: UI_DATA_PART_SCHEMAS;
};

export type { CreateUIMessage, UIMessage };

export class Chat<
  MESSAGE_METADATA = unknown,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas = UIDataPartSchemas,
> {
  readonly #options: Omit<
    ChatOptions<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>,
    'generateId'
  >;
  readonly #generateId: IdGenerator;
  readonly #chatState: SvelteChatState<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >;
  readonly #chatClient: ChatClient<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>;

  /**
   * The id of the chat. If not provided through the constructor, a random ID will be generated
   * using the provided `generateId` function, or a built-in function if not provided.
   */
  get id(): string {
    return this.#chatState.id;
  }

  /** The current value of the input. Writable, so it can be bound to form inputs. */
  input = $state<string>('');

  /**
   * Current messages in the chat.
   *
   * This is writable (both through assignment and array update methods, like `.push`),
   * which is useful when you want to edit the messages on the client, and then
   * trigger {@link reload} to regenerate the AI response.
   */
  get messages(): UIMessage<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >[] {
    return this.#chatState.messages;
  }
  set messages(
    messages: UIMessage<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >[],
  ) {
    this.#chatState.setMessages(messages);
  }

  /**
   * Hook status:
   *
   * - `submitted`: The message has been sent to the API and we're awaiting the start of the response stream.
   * - `streaming`: The response is actively streaming in from the API, receiving chunks of data.
   * - `ready`: The full response has been received and processed; a new user message can be submitted.
   * - `error`: An error occurred during the API request, preventing successful completion.
   */
  get status(): ChatStatus {
    return this.#chatState.status;
  }

  /** The error object of the API request */
  get error(): Error | undefined {
    return this.#chatState.error;
  }

  constructor(
    options: ChatOptions<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS> = {},
  ) {
    this.#options = options;
    this.#generateId = options.generateId ?? generateId;
    this.#chatState = new SvelteChatState(
      options.id ?? this.#generateId(),
      options.messages,
    );
    this.#chatClient = new ChatClient(this.#chatState, {
      ...options,
      generateId: this.#generateId,
      transport:
        options.transport ??
        new DefaultChatTransport({
          api: '/api/chat',
        }),
    });
  }

  /**
   * Append a user message to the chat list. This triggers the API call to fetch
   * the assistant's response.
   * @param message The message to append
   * @param options Additional options to pass to the API call
   */
  append = async (
    message:
      | UIMessage<MESSAGE_METADATA, InferUIDataParts<UI_DATA_PART_SCHEMAS>>
      | CreateUIMessage<
          MESSAGE_METADATA,
          InferUIDataParts<UI_DATA_PART_SCHEMAS>
        >,
    { headers, body }: ChatRequestOptions = {},
  ) => {
    await this.#chatClient.submitMessage({
      message,
      headers,
      body,
      onError: this.#options.onError,
      onToolCall: this.#options.onToolCall,
      onFinish: this.#options.onFinish,
    });
  };

  /**
   * Reload the last AI chat response for the given chat history. If the last
   * message isn't from the assistant, it will request the API to generate a
   * new response.
   */
  reload = async ({ headers, body }: ChatRequestOptions = {}) => {
    await this.#chatClient.resubmitLastUserMessage({
      headers,
      body,
      onError: this.#options.onError,
      onToolCall: this.#options.onToolCall,
      onFinish: this.#options.onFinish,
    });
  };

  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop = () => {
    this.#chatClient.stopStream();
  };

  /** Form submission handler to automatically reset input and append a user message */
  handleSubmit = async (
    event?: { preventDefault?: () => void },
    options: ChatRequestOptions & { files?: FileList } = {},
  ) => {
    event?.preventDefault?.();

    const fileParts = Array.isArray(options?.files)
      ? options.files
      : await convertFileListToFileUIParts(options?.files);

    if (!this.input && fileParts.length === 0) return;

    const request = this.append(
      {
        id: this.#generateId(),
        role: 'user',
        parts: [...fileParts, { type: 'text', text: this.input }],
      },
      {
        headers: options.headers,
        body: options.body,
      },
    );

    this.input = '';
    await request;
  };

  addToolResult = async ({
    toolCallId,
    result,
  }: {
    toolCallId: string;
    result: unknown;
  }) => {
    await this.#chatClient.addToolResult({
      toolCallId,
      result,
    });
  };
}
