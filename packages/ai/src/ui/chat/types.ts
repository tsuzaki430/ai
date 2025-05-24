import { type StandardSchemaV1, type Validator } from '@ai-sdk/provider-utils';
import { type UIDataTypes, type UIMessage } from '../ui-messages';
import { type StreamingUIMessageState } from '../process-ui-message-stream';
import { type SerialJobExecutor } from '../../util';

export type UIDataPartSchemas = Record<
  string,
  Validator<any> | StandardSchemaV1<any>
>;

export type InferUIDataParts<T extends UIDataPartSchemas> = {
  [K in keyof T]: T[K] extends Validator<infer U>
    ? U
    : T[K] extends StandardSchemaV1<infer U>
      ? U
      : unknown;
};

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

export type ActiveResponse<MESSAGE_METADATA> = {
  state: StreamingUIMessageState<MESSAGE_METADATA>;
  abortController: AbortController | undefined;
};

/**
 * Represents a single chat object. UI libraries will need to implement this in their native
 * state management system and plug it into the (TODO, link) ChatClient.
 */
export interface ChatState<MESSAGE_METADATA, DATA_TYPES extends UIDataTypes> {
  readonly id: string;
  readonly status: ChatStatus;
  readonly messages: UIMessage<MESSAGE_METADATA, DATA_TYPES>[];
  readonly error: Error | undefined;
  readonly activeResponse: ActiveResponse<MESSAGE_METADATA> | undefined;
  readonly jobExecutor: SerialJobExecutor;
  setStatus: (status: ChatStatus, error?: Error) => void;
  setActiveResponse: (
    activeResponse: ActiveResponse<MESSAGE_METADATA> | undefined,
  ) => void;
  pushMessage: (message: UIMessage<MESSAGE_METADATA, DATA_TYPES>) => void;
  popMessage: () => void;
  replaceMessage: (
    index: number,
    message: UIMessage<MESSAGE_METADATA, DATA_TYPES>,
  ) => void;
  setMessages: (messages: UIMessage<MESSAGE_METADATA, DATA_TYPES>[]) => void;
}
