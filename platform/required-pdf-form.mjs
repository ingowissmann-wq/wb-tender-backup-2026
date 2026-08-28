import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
} from "pdf-lib";

const MAX_FIELDS = 200;
const MAX_FIELD_NAME = 512;
const MAX_TEXT_VALUE = 20_000;

const loadPdf = async (content) => {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array))
    throw new Error("pdf_form_content_invalid");
  try {
    return await PDFDocument.load(content, { updateMetadata: false });
  } catch {
    throw new Error("pdf_form_invalid_or_encrypted");
  }
};

const fieldDescriptor = (field) => {
  const name = field.getName();
  if (field instanceof PDFSignature)
    return { name, type: "signature", editable: false, reason: "SIGNATURE_FIELD" };
  if (field instanceof PDFTextField)
    return { name, type: "text", editable: true, value: field.getText() || "", multiline: field.isMultiline(), maxLength: field.getMaxLength() || null };
  if (field instanceof PDFCheckBox)
    return { name, type: "checkbox", editable: true, value: field.isChecked() };
  if (field instanceof PDFRadioGroup)
    return { name, type: "radio", editable: true, value: field.getSelected() || "", options: field.getOptions() };
  if (field instanceof PDFDropdown)
    return { name, type: "dropdown", editable: true, value: field.getSelected(), options: field.getOptions(), multiselect: field.isMultiselect() };
  if (field instanceof PDFOptionList)
    return { name, type: "option-list", editable: true, value: field.getSelected(), options: field.getOptions(), multiselect: field.isMultiselect() };
  return { name, type: "unsupported", editable: false, reason: "UNSUPPORTED_FIELD_TYPE" };
};

export async function inspectPdfAcroForm(content) {
  const pdf = await loadPdf(content), descriptors = pdf.getForm().getFields().map(fieldDescriptor);
  const editableFields = descriptors.filter((field) => field.editable);
  return {
    interactive: descriptors.length > 0,
    editable: editableFields.length > 0,
    fields: descriptors,
    editableFields,
    signatureFieldCount: descriptors.filter((field) => field.type === "signature").length,
  };
}

const exactValue = (values, name) => Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
const selectedValues = (value) => Array.isArray(value) ? value.map(String) : [String(value)];

export async function fillPdfAcroForm(content, values = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("pdf_form_values_invalid");
  const entries = Object.entries(values);
  if (!entries.length || entries.length > MAX_FIELDS) throw new Error("pdf_form_values_count_invalid");
  for (const [name] of entries) if (!name || name.length > MAX_FIELD_NAME) throw new Error("pdf_form_field_name_invalid");

  const pdf = await loadPdf(content), form = pdf.getForm(), fields = form.getFields();
  const byName = new Map(fields.map((field) => [field.getName(), field]));
  if (byName.size !== fields.length) throw new Error("pdf_form_duplicate_field_name");
  for (const [name] of entries) if (!byName.has(name)) throw new Error("pdf_form_unknown_field");

  const changedFields = [];
  for (const field of fields) {
    const name = field.getName(), value = exactValue(values, name);
    if (value === undefined) continue;
    if (field instanceof PDFSignature) throw new Error("pdf_form_signature_forbidden");
    if (field instanceof PDFTextField) {
      if (typeof value !== "string" || value.length > MAX_TEXT_VALUE || (field.getMaxLength() && value.length > field.getMaxLength())) throw new Error("pdf_form_text_value_invalid");
      field.setText(value);
    } else if (field instanceof PDFCheckBox) {
      if (typeof value !== "boolean") throw new Error("pdf_form_checkbox_value_invalid");
      value ? field.check() : field.uncheck();
    } else if (field instanceof PDFRadioGroup) {
      if (typeof value !== "string" || (value!==""&&!field.getOptions().includes(value))) throw new Error("pdf_form_option_invalid");
      value==="" ? field.clear() : field.select(value);
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const selected = selectedValues(value);
      if ((!field.isMultiselect() && selected.length !== 1) || selected.some((item) => item!==""&&!field.getOptions().includes(item))) throw new Error("pdf_form_option_invalid");
      selected.length===0||selected.every(item=>item==="") ? field.clear() : field.select(field.isMultiselect() ? selected : selected[0]);
    } else throw new Error("pdf_form_field_type_unsupported");
    changedFields.push(name);
  }

  const bytes = await pdf.save({ addDefaultPage: false, updateFieldAppearances: true });
  return { content: Buffer.from(bytes), changedFields };
}
