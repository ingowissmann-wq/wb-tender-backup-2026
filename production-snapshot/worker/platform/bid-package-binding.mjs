const same=(left,right)=>String(left??"")===String(right??"");
const numberSame=(left,right)=>Number(left)===Number(right);

export const approvedPackageBinding=input=>Object.freeze({
  tenderId:input.tenderId,
  lotKey:input.lotKey??"",
  companyId:input.companyId,
  approvalRequestId:input.approvalRequestId,
  tenderVersionId:input.tenderVersionId,
  documentVersion:input.documentVersion,
  calculationId:input.calculationId,
  calculationVersion:Number(input.calculationVersion),
  managementOutputId:input.managementOutputId,
  managementVersion:Number(input.managementVersion),
  bidVersion:Number(input.bidVersion),
  portalAdapterId:input.portalAdapterId,
  approvalPayloadHash:input.approvalPayloadHash,
});

export function packageMatchesApproval(pkg,binding){
  const manifest=pkg?.manifest||{};
  return Boolean(pkg)&&same(pkg.tender_id,binding.tenderId)&&same(pkg.lot_key,binding.lotKey)&&
    same(pkg.calculation_id,binding.calculationId)&&numberSame(pkg.calculation_version,binding.calculationVersion)&&
    same(pkg.management_output_id,binding.managementOutputId)&&same(pkg.tender_version_id,binding.tenderVersionId)&&
    same(pkg.document_revision_sha256,binding.documentVersion)&&same(pkg.portal_adapter_id,binding.portalAdapterId)&&
    same(manifest.companyId,binding.companyId)&&same(manifest.approvalRequestId,binding.approvalRequestId)&&
    numberSame(manifest.managementVersion,binding.managementVersion)&&numberSame(manifest.offerVersion,binding.bidVersion)&&
    same(manifest.approvalPayloadHash,binding.approvalPayloadHash);
}

export function packageResolution(packages,binding){
  const exact=(packages||[]).find(pkg=>packageMatchesApproval(pkg,binding));
  if(exact)return {action:"REUSE_EXACT",package:exact,supersede:[]};
  return {action:"CREATE_VERSION",package:null,supersede:(packages||[]).filter(pkg=>pkg.status!=="SUPERSEDED")};
}
