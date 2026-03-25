import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { run } from '../../lib/run';
import { azure } from '@ai-sdk/azure';

run(async () => {
  const readDocument = tool({
    description: `Read and return a document by URL`,
    inputSchema: z.object({}),
    execute: async () => ({
      success: true,
      description: 'Successfully loaded document',
      fileUrl: 'https://www.w3.org/TR/2003/REC-PNG-20031110/iso_8859-1.txt', // TXT
      // fileUrl: 'https://cdn.wsform.com/wp-content/uploads/2020/06/industry.csv',  // CSV
      // fileUrl: 'https://www.w3schools.com/xml/plant_catalog.xml',                 // XML
      // fileUrl: 'https://www.berkshirehathaway.com/letters/2024ltr.pdf',           // PDF
    }),
    toModelOutput({ output }) {
      return {
        type: 'content',
        value: [
          {
            type: 'text',
            text: output.description,
          },
          {
            type: 'file-url',
            url: output.fileUrl,
          },
        ],
      };
    },
  });

  const result = await generateText({
    //model: openai.responses('gpt-5.4-mini'), // OpenAIなら動作することを確認。
    model: azure.responses('gpt-5.2'), // Azureではエラー。The file type you uploaded is not supported. Please try again with a pdf
    prompt:
      'Please read the document using the tool provided and return a summary of it.',
    tools: {
      readDocument,
    },
    stopWhen: stepCountIs(4),
  });

  console.log(`Assistant response: ${JSON.stringify(result.text, null, 2)}`);
  console.log(`Warnings: ${JSON.stringify(result.warnings, null, 2)}`);
});
