// A filename is not evidence that a document applies to a different lot.
// bound_lot_key comes from the authoritative enrichment_lots foreign key.
export function selectCalculationDocuments(documents,selectedLotKey) {
  return documents.filter(document=>{
    if(document.lot_id)return Boolean(selectedLotKey)&&document.bound_lot_key===selectedLotKey;
    return document.provenance?.lotScope==='TENDER_GLOBAL' && !document.provenance?.lotKey
      && !['EXPLICIT_PATH_CONFLICT','EXPLICIT_LOT_UNRESOLVED'].includes(document.provenance?.lotBindingSource);
  }).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
}
