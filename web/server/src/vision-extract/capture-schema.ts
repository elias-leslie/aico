// What aico reads out of a captured photo, PDF or voice note in one call. The
// router (Milestone 3) builds on these fields; nothing here routes or files.

import type { JsonSchema } from './validate'

export const CAPTURE_TYPES = [
  'grocery_list',
  'receipt',
  'odometer',
  'service_invoice',
  'recipe',
  'note',
  'document',
  'other',
] as const

const nullableString = { type: ['string', 'null'] }
const nullableNumber = { type: ['number', 'null'] }

export const CAPTURE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...CAPTURE_TYPES] },
    title: { type: 'string' },
    text: { type: 'string' },
    summary: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, struck: { type: 'boolean' } },
        required: ['text', 'struck'],
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          as_written: { type: 'string' },
          item: { type: 'string' },
          quantity: nullableString,
          struck: { type: 'boolean' },
        },
        required: ['as_written', 'item', 'quantity', 'struck'],
      },
    },
    receipt: {
      type: ['object', 'null'],
      properties: {
        store: nullableString,
        date: nullableString,
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              number: nullableString,
              description: { type: 'string' },
              price: nullableNumber,
            },
            required: ['number', 'description', 'price'],
          },
        },
        subtotal: nullableNumber,
        tax: nullableNumber,
        total: nullableNumber,
      },
      required: ['store', 'date', 'items', 'subtotal', 'tax', 'total'],
    },
    odometer: {
      type: ['object', 'null'],
      properties: { odometer: nullableNumber, trip: nullableNumber },
      required: ['odometer', 'trip'],
    },
  },
  required: ['type', 'title', 'text', 'summary', 'lines', 'items', 'receipt', 'odometer'],
}

/** What the reader is told to do. Plain words; the schema carries the structure. */
export const CAPTURE_INSTRUCTIONS = [
  'Read this file exactly (a photo, a scan, a PDF or a voice recording) and fill in the JSON.',
  `type: what it is: ${CAPTURE_TYPES.join(', ')}.`,
  'title: a short name for it. summary: one plain sentence.',
  "text: everything written or said, top to bottom, with line breaks, in the writer's own spelling. For audio, a transcript. No commentary of your own.",
  'lines: the same text line by line; struck is true for a line crossed out.',
  'items: for a list (groceries, things to do), one entry per item. as_written is the item exactly as written, spelling mistakes included; item is the cleaned-up name (for example "see weeds" becomes "seaweed"); quantity is as written or null; struck is true when crossed out. Otherwise an empty list.',
  'receipt: for a receipt, the store, date (YYYY-MM-DD when readable), each line item (item number, description, price, discounts as negative), subtotal, tax and total. Otherwise null.',
  'odometer: for a dashboard or odometer photo, the odometer reading and the trip reading. Otherwise null.',
  "Never guess a value you can't read: use null, or leave it out of text.",
].join('\n')
