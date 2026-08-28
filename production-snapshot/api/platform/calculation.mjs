const required = ["productiveHours","baseHourlyRate","employerBurdenRate","overheadRate","riskRate","targetMarginRate"];
const n = (value,name) => { const result=Number(value); if(!Number.isFinite(result)||result<0)throw new Error(`invalid_${name}`); return result; };
export function calculateScenario(input,config) {
  const missing=[...required,...(config.requiredInputs||[])].filter((key)=>input[key]===undefined||input[key]===null||input[key]==="");
  if(missing.length)return {status:"BLOCKED",missing,items:[],totals:{}};
  const hours=n(input.productiveHours,"productiveHours"), wage=n(input.baseHourlyRate,"baseHourlyRate");
  const wageCost=hours*wage;
  const supplements=Object.entries(input.supplementHours||{}).reduce((sum,[code,value])=>sum+n(value,code)*wage*n(config.supplementRates?.[code]||0,code),0);
  const employer=wageCost*n(input.employerBurdenRate,"employerBurdenRate");
  const absence=wageCost*n(input.absenceReserveRate||0,"absenceReserveRate");
  const direct=wageCost+supplements+employer+absence+["material","machines","vehicles","travel","accommodation","insurance","subcontractors","recruitment","training","clearances","certificates","financing"].reduce((sum,key)=>sum+n(input[key]||0,key),0);
  const overhead=direct*n(input.overheadRate,"overheadRate"), risk=(direct+overhead)*n(input.riskRate,"riskRate");
  const selfCost=direct+overhead+risk;
  const floor=selfCost, recommended=selfCost/(1-n(input.targetMarginRate,"targetMarginRate"));
  const strategic=recommended*(1+n(input.strategyPremiumRate||0,"strategyPremiumRate"));
  const db1=strategic-direct, db2=strategic-direct-overhead, db3=strategic-selfCost;
  const months=n(input.contractMonths||12,"contractMonths");
  const items=[
    ["WAGE","Lohnkosten","productiveHours * baseHourlyRate",wageCost],
    ["SUPPLEMENTS","Zuschläge","sum(hours * wage * rate)",supplements],
    ["EMPLOYER","Arbeitgebernebenkosten","wageCost * employerBurdenRate",employer],
    ["ABSENCE","Ausfallreserve","wageCost * absenceReserveRate",absence],
    ["OVERHEAD","Verwaltung","direct * overheadRate",overhead],
    ["RISK","Risikopuffer","(direct + overhead) * riskRate",risk],
  ].map(([code,label,formula,amount])=>({code,label,formula,amount,unit:"EUR",source:"maintained configuration",assumptionStatus:"CONFIGURED",configVersion:config.version}));
  return {status:"CALCULATED",missing:[],items,totals:{direct,selfCost,floor,recommended,strategic,db1,db2,db3,db1Pct:db1/strategic,db2Pct:db2/strategic,db3Pct:db3/strategic,monthly:strategic/months,annual:strategic/months*12,totalContractValue:strategic,fTE:hours/(n(config.fteAnnualHours||1600,"fteAnnualHours")*months/12)}};
}
export function sensitivity(input,config){return {best:calculateScenario({...input,riskRate:Number(input.riskRate)*0.75},config),base:calculateScenario(input,config),worst:calculateScenario({...input,riskRate:Number(input.riskRate)*1.5,productiveHours:Number(input.productiveHours)*1.1},config)}}

