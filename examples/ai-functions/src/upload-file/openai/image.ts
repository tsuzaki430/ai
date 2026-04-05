import { createOpenAI, openai } from '@ai-sdk/openai';
import { generateText, uploadFile } from 'ai';
import fs from 'node:fs';
import { run } from '../../lib/run';

run(async () => {
  const openai = createOpenAI({
    baseURL: `https://${process.env.AZURE_RESOURCE_NAME}.openai.azure.com/openai/v1/`,
    apiKey: process.env.AZURE_API_KEY,
  });

  const { providerReference, mediaType, filename, providerMetadata } =
    await uploadFile({
      api: openai.files(),
      data: fs.readFileSync('./data/comic-cat.png'),
      filename: 'comic-cat.png',
    });

  console.log('Provider reference:', providerReference);
  console.log('Media type:', mediaType);
  console.log('Filename:', filename);
  console.log('Provider metadata:', providerMetadata);

  const result = await generateText({
    model: openai.responses('gpt-4o-mini'),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe what you see in this image.',
          },
          {
            type: 'image',
            image: providerReference,
          },
        ],
      },
    ],
  });

  console.log(result.text);
});
