import {
  FetchFunction,
  StandardSchemaV1,
  Validator,
} from '@ai-sdk/provider-utils';
import {
  type ActiveResponse,
  ChatClient,
  type ChatState,
  type ChatStatus,
  ChatTransport,
  DefaultChatTransport,
  IdGenerator,
  InferUIDataParts,
  SerialJobExecutor,
  type UIDataPartSchemas,
  type UIDataTypes,
  type UIMessage,
  generateId as generateIdFunc,
} from 'ai';

export interface ChatStoreSubscriber {
  onChatChanged: (event: ChatStoreEvent) => void;
}

export interface ChatStoreEvent {
  type: 'chat-messages-changed' | 'chat-status-changed';
  chatId: number | string;
  error?: Error;
}

type ChatClientInstance<
  MESSAGE_METADATA,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas,
> = InstanceType<typeof ChatClient<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>>;

type ChatClientMethodWithId<
  METHOD_TYPE extends keyof ChatClientInstance<
    MESSAGE_METADATA,
    UI_DATA_PART_SCHEMAS
  >,
  MESSAGE_METADATA = unknown,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas = UIDataPartSchemas,
> = (
  id: string,
  ...args: Parameters<
    ChatClientInstance<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>[METHOD_TYPE]
  >
) => ReturnType<
  ChatClientInstance<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>[METHOD_TYPE]
>;

class ReactStateManager<MESSAGE_METADATA, DATA_TYPES extends UIDataTypes>
  implements ChatState<MESSAGE_METADATA, DATA_TYPES>
{
  readonly id: string;
  messages: UIMessage<MESSAGE_METADATA, DATA_TYPES>[];
  status: ChatStatus = 'ready';
  error: Error | undefined = undefined;
  activeResponse: ActiveResponse<MESSAGE_METADATA> | undefined = undefined;
  jobExecutor = new SerialJobExecutor();

  constructor(
    private emit: (event: ChatStoreEvent) => void,
    id: string,
    messages?: UIMessage<MESSAGE_METADATA, DATA_TYPES>[],
  ) {
    this.id = id;
    this.messages = messages ?? [];
  }

  setStatus = (status: ChatStatus, error?: Error) => {
    this.status = status;
    this.error = error;
    this.emit({
      type: 'chat-status-changed',
      chatId: this.id,
      error,
    });
  };

  setActiveResponse = (
    activeResponse: ActiveResponse<MESSAGE_METADATA> | undefined,
  ) => {
    this.activeResponse = activeResponse;
  };

  setMessages = (messages: UIMessage<MESSAGE_METADATA, DATA_TYPES>[]) => {
    this.messages = [...messages];
    this.emit({
      type: 'chat-messages-changed',
      chatId: this.id,
    });
  };

  pushMessage = (message: UIMessage<MESSAGE_METADATA, DATA_TYPES>) => {
    this.messages = this.messages.concat(message);
    this.emit({
      type: 'chat-messages-changed',
      chatId: this.id,
    });
  };

  popMessage = () => {
    this.messages = this.messages.slice(0, -1);
    this.emit({
      type: 'chat-messages-changed',
      chatId: this.id,
    });
  };

  replaceMessage = (
    index: number,
    message: UIMessage<MESSAGE_METADATA, DATA_TYPES>,
  ) => {
    this.messages = [
      ...this.messages.slice(0, index),
      message,
      ...this.messages.slice(index + 1),
    ];
    this.emit({
      type: 'chat-messages-changed',
      chatId: this.id,
    });
  };
}

export class ChatStore<
  MESSAGE_METADATA,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas,
> {
  private chats: Map<
    string,
    {
      state: ChatState<
        MESSAGE_METADATA,
        InferUIDataParts<UI_DATA_PART_SCHEMAS>
      >;
      client: ChatClient<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>;
    }
  >;
  private subscribers: Set<ChatStoreSubscriber>;
  private generateId: IdGenerator;
  private messageMetadataSchema:
    | Validator<MESSAGE_METADATA>
    | StandardSchemaV1<MESSAGE_METADATA>
    | undefined;
  private dataPartSchemas: UI_DATA_PART_SCHEMAS | undefined;
  private transport: ChatTransport<
    MESSAGE_METADATA,
    InferUIDataParts<UI_DATA_PART_SCHEMAS>
  >;
  private maxSteps: number;

  constructor({
    chats = {},
    generateId,
    transport,
    maxSteps = 1,
    messageMetadataSchema,
    dataPartSchemas,
  }: {
    chats?: {
      [id: string]: {
        messages: UIMessage<
          MESSAGE_METADATA,
          InferUIDataParts<UI_DATA_PART_SCHEMAS>
        >[];
      };
    };
    generateId?: IdGenerator;
    transport: ChatTransport<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >;
    maxSteps?: number;
    messageMetadataSchema?:
      | Validator<MESSAGE_METADATA>
      | StandardSchemaV1<MESSAGE_METADATA>;
    dataPartSchemas?: UI_DATA_PART_SCHEMAS;
  }) {
    this.maxSteps = maxSteps;
    this.transport = transport;
    this.subscribers = new Set();
    this.generateId = generateId ?? generateIdFunc;
    this.messageMetadataSchema = messageMetadataSchema;
    this.dataPartSchemas = dataPartSchemas;

    this.chats = new Map(
      Object.entries(chats).map(([id, chat]) => [
        id,
        this.newChatClient(id, chat.messages),
      ]),
    );
  }

  hasChat(id: string) {
    return this.chats.has(id);
  }

  addChat(
    id: string,
    messages: UIMessage<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >[],
  ) {
    this.chats.set(id, this.newChatClient(id, messages));
  }

  getChats() {
    return Array.from(this.chats.entries());
  }

  get chatCount() {
    return this.chats.size;
  }

  getStatus(id: string): ChatStatus {
    return this.getClient(id).state.status;
  }

  setStatus({
    id,
    status,
    error,
  }: {
    id: string;
    status: ChatStatus;
    error?: Error;
  }) {
    const { state } = this.getClient(id);
    if (state.status === status) return;
    state.setStatus(status, error);
  }

  getError(id: string) {
    return this.getClient(id).state.error;
  }

  getMessages(id: string) {
    return this.getClient(id).state.messages;
  }

  getLastMessage(id: string) {
    const { state } = this.getClient(id);
    return state.messages[state.messages.length - 1];
  }

  subscribe(subscriber: ChatStoreSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  setMessages({
    id,
    messages,
  }: {
    id: string;
    messages: UIMessage<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >[];
  }) {
    this.getClient(id).state.setMessages(messages);
  }

  removeAssistantResponse: ChatClientMethodWithId<
    'removeAssistantResponse',
    MESSAGE_METADATA,
    UI_DATA_PART_SCHEMAS
  > = id => this.getClient(id).client.removeAssistantResponse();

  submitMessage: ChatClientMethodWithId<
    'submitMessage',
    MESSAGE_METADATA,
    UI_DATA_PART_SCHEMAS
  > = (id, ...args) => this.getClient(id).client.submitMessage(...args);

  resubmitLastUserMessage: ChatClientMethodWithId<
    'resubmitLastUserMessage',
    MESSAGE_METADATA,
    UI_DATA_PART_SCHEMAS
  > = (id, ...args) =>
    this.getClient(id).client.resubmitLastUserMessage(...args);

  resumeStream: ChatClientMethodWithId<
    'resumeStream',
    MESSAGE_METADATA,
    UI_DATA_PART_SCHEMAS
  > = (id, ...args) => this.getClient(id).client.resumeStream(...args);

  addToolResult: ChatClientMethodWithId<
    'addToolResult',
    MESSAGE_METADATA,
    UI_DATA_PART_SCHEMAS
  > = (id, ...args) => this.getClient(id).client.addToolResult(...args);

  stopStream: ChatClientMethodWithId<
    'stopStream',
    MESSAGE_METADATA,
    UI_DATA_PART_SCHEMAS
  > = (id, ...args) => this.getClient(id).client.stopStream(...args);

  private getClient(id: string) {
    if (!this.chats.has(id)) {
      this.chats.set(id, this.newChatClient(id, []));
    }
    return this.chats.get(id)!;
  }

  private emit = (event: ChatStoreEvent) => {
    for (const subscriber of this.subscribers) {
      subscriber.onChatChanged(event);
    }
  };

  private newChatClient(
    id: string,
    messages: UIMessage<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >[],
  ) {
    const state = new ReactStateManager(this.emit, id, messages);
    const client = new ChatClient(state, {
      generateId: this.generateId,
      transport: this.transport,
      maxSteps: this.maxSteps,
      messageMetadataSchema: this.messageMetadataSchema,
      dataPartSchemas: this.dataPartSchemas,
    });
    return { state, client };
  }
}

export interface DefaultChatStoreOptions<
  MESSAGE_METADATA = unknown,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas = UIDataPartSchemas,
> {
  /**
   * Schema for the message metadata. Validates the message metadata.
   * Message metadata can be undefined or must match the schema.
   */
  messageMetadataSchema?:
    | Validator<MESSAGE_METADATA>
    | StandardSchemaV1<MESSAGE_METADATA>;

  /**
   * Schema for the data types. Validates the data types.
   */
  dataPartSchemas?: UI_DATA_PART_SCHEMAS;

  /**
   * The API endpoint that accepts a `{ messages: Message[] }` object and returns
   * a stream of tokens of the AI chat response.
   */
  api: string;

  /**
   * A way to provide a function that is going to be used for ids for messages and the chat.
   * If not provided the default AI SDK `generateId` is used.
   */
  generateId?: IdGenerator;

  /**
   * The credentials mode to be used for the fetch request.
   * Possible values are: 'omit', 'same-origin', 'include'.
   * Defaults to 'same-origin'.
   */
  credentials?: RequestCredentials;

  /**
   * HTTP headers to be sent with the API request.
   */
  headers?: Record<string, string> | Headers;

  /**
   * Extra body object to be sent with the API request.
   * @example
   * Send a `sessionId` to the API along with the messages.
   * ```js
   * useChat({
   *   body: {
   *     sessionId: '123',
   *   }
   * })
   * ```
   */
  body?: object;

  /**
    Custom fetch implementation. You can use it as a middleware to intercept requests,
    or to provide a custom fetch implementation for e.g. testing.
        */
  fetch?: FetchFunction;

  /**
    Maximum number of sequential LLM calls (steps), e.g. when you use tool calls.
    Must be at least 1.

    A maximum number is required to prevent infinite loops in the case of misconfigured tools.

    By default, it's set to 1, which means that only a single LLM call is made.
     */
  maxSteps?: number;

  /**
   * When a function is provided, it will be used
   * to prepare the request body for the chat API. This can be useful for
   * customizing the request body based on the messages and data in the chat.
   *
   * @param chatId The id of the chat.
   * @param messages The current messages in the chat.
   * @param requestBody The request body object passed in the chat request.
   */
  prepareRequestBody?: (options: {
    chatId: string;
    messages: UIMessage<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >[];
    requestBody?: object;
  }) => unknown;

  chats?: {
    [id: string]: {
      messages: UIMessage<
        MESSAGE_METADATA,
        InferUIDataParts<UI_DATA_PART_SCHEMAS>
      >[];
    };
  };
}

export function defaultChatStore<
  MESSAGE_METADATA = unknown,
  UI_DATA_PART_SCHEMAS extends UIDataPartSchemas = UIDataPartSchemas,
>({
  api,
  fetch,
  credentials,
  headers,
  body,
  prepareRequestBody,
  generateId = generateIdFunc,
  messageMetadataSchema,
  maxSteps = 1,
  dataPartSchemas,
  chats,
}: DefaultChatStoreOptions<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>): ChatStore<
  MESSAGE_METADATA,
  UI_DATA_PART_SCHEMAS
> {
  return new ChatStore<MESSAGE_METADATA, UI_DATA_PART_SCHEMAS>({
    transport: new DefaultChatTransport<
      MESSAGE_METADATA,
      InferUIDataParts<UI_DATA_PART_SCHEMAS>
    >({
      api,
      fetch,
      credentials,
      headers,
      body,
      prepareRequestBody,
    }),
    generateId,
    messageMetadataSchema,
    dataPartSchemas,
    maxSteps,
    chats,
  });
}
