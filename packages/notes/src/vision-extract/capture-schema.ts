// What aico reads out of a captured photo, PDF or voice note in one call. The
// router (Milestone 3) builds on these fields; nothing here routes or files.

import type { JsonSchema } from './validate'

export const CAPTURE_TYPES = [
  'grocery_list',
  'receipt',
  'odometer',
  'service_invoice',
  'vehicle_note',
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
      properties: { odometer: nullableNumber, trip: nullableNumber, unit: nullableString },
      required: ['odometer', 'trip', 'unit'],
    },
    vehicle: {
      type: ['object', 'null'],
      properties: {
        hint: nullableString,
        date: nullableString,
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string' }, note: { type: 'string' } },
            required: ['kind', 'note'],
          },
        },
      },
      required: ['hint', 'date', 'services'],
    },
  },
  required: [
    'type',
    'title',
    'text',
    'summary',
    'lines',
    'items',
    'receipt',
    'odometer',
    'vehicle',
  ],
}

/** What the reader is told to do. Plain words; the schema carries the structure. */
export const CAPTURE_INSTRUCTIONS = [
  'Read this file exactly (a photo, a scan, a PDF or a voice recording) and fill in the JSON.',
  `type: what it is: ${CAPTURE_TYPES.join(', ')}. vehicle_note is a spoken or written note about work done on a car with no odometer photo or invoice.`,
  'title: a short name for it. summary: one plain sentence.',
  "text: everything written or said, top to bottom, with line breaks, in the writer's own spelling. For audio, a transcript. No commentary of your own.",
  'lines: the same text line by line; struck is true only when a line is drawn through the middle of the words. Underlining is not crossing out.',
  'items: for a list (groceries, things to do), one entry per item. as_written is the item exactly as written, spelling mistakes included; item is the cleaned-up name (for example "see weeds" becomes "seaweed"); quantity is as written or null; struck is true only when the whole item is crossed out (underlined is not struck). When only some words in an item are crossed out, leave those words out of item; never invent words you cannot read. Otherwise an empty list.',
  'receipt: for a receipt, the store, date (YYYY-MM-DD when readable), each line item (item number, description, price, discounts as negative), subtotal, tax and total. Otherwise null.',
  'odometer: for a dashboard or odometer photo (or an invoice that prints the mileage), the odometer reading, the trip reading, and unit ("mi" or "km", only when the display or page shows it, else null). Otherwise null.',
  'vehicle: for anything about a car (odometer, service invoice, or a spoken or written note such as "just changed the oil, rotated the tires"): hint is what the file or the owner\'s words say about which car (year, make, model, trim, VIN, plate, as written, e.g. "2019 Subaru Outback"), or null; date is when the work was done or the reading taken (YYYY-MM-DD) when stated, else null; services lists each piece of work done, kind a short name ("oil change", "tire rotation") and note the details (shop, parts, cost) or an empty string. Otherwise null.',
  "Never guess a value you can't read: use null, or leave it out of text.",
].join('\n')
