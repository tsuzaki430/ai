import {
  createAzure,
  OpenAILanguageModelResponsesOptions,
  AzureResponsesReasoningProviderMetadata,
} from '@ai-sdk/azure';
import { createWebSocketFetch } from 'ai-sdk-openai-websocket-fetch';
import { streamText } from 'ai';
import { run } from '../../lib/run';

run(async () => {
  const wsFetch = createWebSocketFetch();

  const openai = createAzure({ fetch: wsFetch });
  const result = streamText({
    model: openai('gpt-5'),
    prompt: 'How many "r"s are in the word "strawberry"?',
    reasoning: 'low',
    providerOptions: {
      openai: {
        reasoningSummary: 'detailed',
      } satisfies OpenAILanguageModelResponsesOptions,
    },
    onFinish: () => wsFetch.close(), // close the WebSocket when done
  });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case 'reasoning-start':
        process.stdout.write('\x1b[34m');
        break;

      case 'reasoning-delta':
        process.stdout.write(chunk.text);
        break;

      case 'reasoning-end':
        process.stdout.write('\x1b[0m');
        process.stdout.write('\n');
        const providerMetadata = chunk.providerMetadata as
          | AzureResponsesReasoningProviderMetadata
          | undefined;
        if (!providerMetadata) break;
        const {
          azure: { itemId, reasoningEncryptedContent },
        } = providerMetadata;
        console.log(`itemId: ${itemId}`);

        // In the Responses API, store is set to true by default, so conversation history is cached.
        // The reasoning tokens from that interaction are also cached, and as a result, reasoningEncryptedContent returns null.
        console.log(`reasoningEncryptedContent: ${reasoningEncryptedContent}`);
        break;

      case 'text-start':
        process.stdout.write('\x1b[0m');
        break;

      case 'text-delta':
        process.stdout.write(chunk.text);
        break;

      case 'text-end':
        process.stdout.write('\x1b[0m');
        console.log();
        break;
    }
  }
});
