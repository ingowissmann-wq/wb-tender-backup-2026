import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCalculationDocuments} from '../platform/calculation-document-scope.mjs';
import {buildFullTenderReview} from '../platform/full-tender-review.mjs';
test('calculation uses only its exact lot and explicitly shared documents, never filename guesses',()=>{
 const docs=[
  {id:'a',lot_id:'lot-one-id',bound_lot_key:'LOT-0001',filename:'Preisblatt.xlsx'},
  {id:'b',lot_id:'lot-two-id',bound_lot_key:'LOT-0002',filename:'Vertrag.pdf',provenance:{lotBindingSource:'PARENT_DOCUMENT'}},
  {id:'c',lot_id:null,filename:'Vertrag.pdf'},
  {id:'d',lot_id:null,filename:'Vertrag.pdf',provenance:{lotScope:'TENDER_GLOBAL'}},
  {id:'e',lot_id:null,filename:'Vertrag.pdf',provenance:{lotScope:'TENDER_GLOBAL',lotBindingSource:'EXPLICIT_PATH_CONFLICT'}},
  {id:'f',lot_id:null,filename:'Vertrag.pdf',provenance:{lotScope:'TENDER_GLOBAL',lotKey:'LOT-0002'}}
 ];
 assert.deepEqual(selectCalculationDocuments(docs,'LOT-0001').map(x=>x.id),['a','d']);
 assert.deepEqual(selectCalculationDocuments(docs,'LOT-0002').map(x=>x.id),['b','d']);
 assert.deepEqual(selectCalculationDocuments(docs,null).map(x=>x.id),['d']);
 assert.deepEqual(selectCalculationDocuments([...docs].reverse(),'LOT-0001'),selectCalculationDocuments(docs,'LOT-0001'));
});
test('the preliminary review never emits a parallel wage-times-markup price',()=>{
 const tender={id:'synthetic',title:'Unterhaltsreinigung Schule',description:'Gebäudereinigung und Unterhaltsreinigung',cpv_codes:['90911200'],duration_months:12};
 const result=buildFullTenderReview({tender,company:{company_id:'synthetic-company',legal_name:'SYNTHETIC Cleaning',technical_key:'synthetic-cleaning',sector_slug:'cleaning'},parameters:[{parameter_key:'C01',new_value:20},{parameter_key:'C08',new_value:10},{parameter_key:'C19',new_value:20}],enrichment:{structured_data:{...tender,areas:100,quantities:1,intervals:'täglich',hours:100,duration:12}},region:{classification:'CORE_REGION',regional_decision:'INCLUDED'}});
 assert.equal(result.calculation.status,'BEREIT_FUER_KALKULATIONSENGINE');
 assert.equal(result.calculation.neededHours,100);
 assert.equal(result.calculation.targetPrice,undefined);assert.equal(result.calculation.directWages,undefined);assert.equal(result.recommendation.recommendedPrice,null);assert.notEqual(result.recommendation.decision,'GO');
});
