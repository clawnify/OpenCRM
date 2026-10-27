# Implementation decisions

## Reviewed custom fields on import (#3)

- Reuse the existing field-creation and bulk-import APIs. Successful field
  creations remain in the schema if a later step fails; the current review
  remembers them for retry. This avoids introducing a separate schema/import
  transaction API for this feature.
- Infer locally, with user-editable suggestions. Inspect the full column for
  badge options so values outside the preview are retained. Use `custom_` keys
  with collision suffixes to avoid both system and existing custom fields.
- Preserve CSV text and Excel display text. Convert tags and checkbox values
  when building the import payload, including later imports into those fields.

See [custom properties](custom-properties.md#7-import-inference-the-payoff)
for the user flow and failure behavior.
