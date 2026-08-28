import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const PDF_OVERLAY_LIMITS = Object.freeze({
  maxElements: 500,
  maxPayloadBytes: 1_000_000,
  maxTextLength: 2_000,
  maxTotalTextLength: 100_000,
});

const TYPES = new Set(["text", "checkbox", "mark", "note"]);
const MARKS = new Set(["x", "check", "yes", "no", "highlight"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const COLORS = Object.freeze({ black: rgb(0, 0, 0), blue: rgb(0.03, 0.2, 0.55), red: rgb(0.75, 0.06, 0.06) });
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.has(key));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const coordinate = (value) => finite(value) && value >= 0 && value <= 1;

export function normalizeOverlayRect(rect, viewport) {
  if (!rect || !viewport || !finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error("pdf_overlay_viewport_invalid");
  const normalized = { x: rect.left / viewport.width, y: rect.top / viewport.height, width: rect.width / viewport.width, height: rect.height / viewport.height };
  if (![normalized.x, normalized.y, normalized.width, normalized.height].every(coordinate) || normalized.width <= 0 || normalized.height <= 0 || normalized.x + normalized.width > 1.000001 || normalized.y + normalized.height > 1.000001) throw new Error("pdf_overlay_coordinates_invalid");
  return normalized;
}

export function validatePdfOverlays(input, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("pdf_overlay_page_count_invalid");
  if (!Array.isArray(input) || input.length > PDF_OVERLAY_LIMITS.maxElements) throw new Error("pdf_overlay_elements_invalid");
  const ids = new Set();
  let totalTextLength = 0;
  const elements = input.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pdf_overlay_element_invalid");
    if (!exactKeys(raw, new Set(["id", "type", "page", "x", "y", "width", "height", "text", "checked", "mark", "color", "fontSize"]))) throw new Error("pdf_overlay_property_invalid");
    const { id, type, page, x, y, width, height } = raw;
    if (typeof id !== "string" || !ID.test(id) || ids.has(id)) throw new Error("pdf_overlay_id_invalid");
    ids.add(id);
    if (!TYPES.has(type) || type === "signature") throw new Error("pdf_overlay_type_invalid");
    if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new Error("pdf_overlay_page_invalid");
    if (![x, y, width, height].every(coordinate) || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) throw new Error("pdf_overlay_coordinates_invalid");
    const color = raw.color ?? (type === "note" ? "blue" : "black");
    if (!Object.hasOwn(COLORS, color)) throw new Error("pdf_overlay_color_invalid");
    const element = { id, type, page, x, y, width, height, color };
    if (type === "text" || type === "note") {
      if (typeof raw.text !== "string" || raw.text.length > PDF_OVERLAY_LIMITS.maxTextLength) throw new Error("pdf_overlay_text_invalid");
      totalTextLength += raw.text.length;
      const fontSize = raw.fontSize ?? Math.min(height * 0.7, 0.03);
      if (!finite(fontSize) || fontSize < 0.003 || fontSize > 0.2) throw new Error("pdf_overlay_font_size_invalid");
      Object.assign(element, { text: raw.text, fontSize });
    } else if (type === "checkbox") {
      if (typeof raw.checked !== "boolean" || (raw.mark != null && !new Set(["x", "check"]).has(raw.mark))) throw new Error("pdf_overlay_checkbox_invalid");
      Object.assign(element, { checked: raw.checked, mark: raw.mark || "x" });
    } else {
      if (!MARKS.has(raw.mark)) throw new Error("pdf_overlay_mark_invalid");
      element.mark = raw.mark;
    }
    return element;
  });
  if (totalTextLength > PDF_OVERLAY_LIMITS.maxTotalTextLength) throw new Error("pdf_overlay_total_text_invalid");
  return elements;
}

export const summarizePdfOverlays = (elements) => ({
  elementCount: elements.length,
  elementIds: elements.map(({ id }) => id),
  elements: elements.map(({ id, type, page, x, y, width, height, color, mark, checked }) => ({
    id, type, page, x, y, width, height, color,
    ...(mark ? { mark } : {}),
    ...(type === "checkbox" ? { checked } : {}),
  })),
});

const drawCheck = (page, x, y, width, height, color, mark) => {
  const thickness = Math.max(0.8, Math.min(width, height) * 0.09);
  if (mark === "check") {
    page.drawLine({ start: { x: x + width * 0.12, y: y + height * 0.48 }, end: { x: x + width * 0.4, y: y + height * 0.18 }, thickness, color });
    page.drawLine({ start: { x: x + width * 0.4, y: y + height * 0.18 }, end: { x: x + width * 0.9, y: y + height * 0.86 }, thickness, color });
  } else {
    page.drawLine({ start: { x: x + width * 0.12, y: y + height * 0.12 }, end: { x: x + width * 0.88, y: y + height * 0.88 }, thickness, color });
    page.drawLine({ start: { x: x + width * 0.12, y: y + height * 0.88 }, end: { x: x + width * 0.88, y: y + height * 0.12 }, thickness, color });
  }
};

export async function inspectPdfForOverlay(content) {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) throw new Error("pdf_overlay_content_invalid");
  let pdf;
  try { pdf = await PDFDocument.load(content, { updateMetadata: false }); }
  catch { throw new Error("pdf_overlay_invalid_or_encrypted"); }
  return { pageCount: pdf.getPageCount(), pages: pdf.getPages().map((page, index) => ({ page: index + 1, width: page.getWidth(), height: page.getHeight() })) };
}

export async function renderPdfOverlays(content, input) {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) throw new Error("pdf_overlay_content_invalid");
  let pdf;
  try { pdf = await PDFDocument.load(content, { updateMetadata: false }); }
  catch { throw new Error("pdf_overlay_invalid_or_encrypted"); }
  const elements = validatePdfOverlays(input, pdf.getPageCount());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const element of elements) {
    const page = pdf.getPage(element.page - 1), pageWidth = page.getWidth(), pageHeight = page.getHeight();
    const x = element.x * pageWidth, width = element.width * pageWidth, height = element.height * pageHeight;
    const y = pageHeight - (element.y * pageHeight) - height;
    const color = COLORS[element.color];
    if (element.type === "text" || element.type === "note") {
      const size = Math.max(3, element.fontSize * pageHeight), lines = element.text.replace(/\r/g, "").split("\n");
      if (element.type === "note") page.drawRectangle({ x, y, width, height, color: rgb(1, 0.98, 0.72), opacity: 0.72, borderColor: color, borderWidth: 0.5 });
      const maxLines = Math.max(1, Math.floor(height / (size * 1.2)));
      page.drawText(lines.slice(0, maxLines).join("\n"), { x: x + 1.5, y: y + height - size, size, font, color, lineHeight: size * 1.2, maxWidth: Math.max(1, width - 3) });
    } else if (element.type === "checkbox") {
      page.drawRectangle({ x, y, width, height, borderColor: color, borderWidth: Math.max(0.8, Math.min(width, height) * 0.05) });
      if (element.checked) drawCheck(page, x, y, width, height, color, element.mark);
    } else if (element.mark === "highlight") {
      page.drawRectangle({ x, y, width, height, color: rgb(1, 0.9, 0.15), opacity: 0.35 });
    } else if (element.mark === "yes" || element.mark === "no") {
      const label = element.mark === "yes" ? "JA" : "NEIN", size = Math.max(3, Math.min(height * 0.75, width / (label.length * 0.6)));
      page.drawText(label, { x, y: y + Math.max(0, (height - size) / 2), size, font, color });
    } else drawCheck(page, x, y, width, height, color, element.mark);
  }
  return { content: Buffer.from(await pdf.save({ addDefaultPage: false, updateFieldAppearances: true })), elements, pageCount: pdf.getPageCount() };
}
