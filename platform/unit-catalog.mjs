const normalizeText=value=>String(value??"").normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase("de-DE");
const unit=(id,label,aliases,dataType="DECIMAL")=>Object.freeze({
 id,label,aliases:Object.freeze([...new Set([id,label,...aliases])]),dataType,
 allowedInputForms:Object.freeze(dataType==="DECIMAL"?["de-DE decimal comma","decimal point"]:["structured text"]),
 normalization:dataType==="DECIMAL"?"decimal comma or point to finite JSON number":"NFKC text preserved without semantic conversion",
 conversion:null,
});

export const units=Object.freeze({
 EUR_PER_HOUR:unit("EUR_PER_HOUR","EUR/Stunde",["EUR/h","€/Stunde","€/h"]),
 TARIFF_AGREEMENT_DATE:unit("TARIFF_AGREEMENT_DATE","Tarifwerk/Datum",[],"STRUCTURED_TEXT"),
 PERCENT_BY_TYPE:unit("PERCENT_BY_TYPE","Prozent je Art",["% je Art"],"STRUCTURED_PERCENT_BREAKDOWN"),
 PERCENT:unit("PERCENT","Prozent",["%"]),
 EUR:unit("EUR","EUR",["€"]),
 EUR_PER_UNIT:unit("EUR_PER_UNIT","EUR/Einheit",["€/Einheit"]),
 EUR_PER_OBJECT:unit("EUR_PER_OBJECT","EUR/Objekt",["€/Objekt"]),
 EUR_PER_MONTH:unit("EUR_PER_MONTH","EUR/Monat",["€/Monat"]),
 EUR_PER_KM:unit("EUR_PER_KM","EUR/km",["€/km"]),
 EUR_PER_FTE:unit("EUR_PER_FTE","EUR/FTE",["€/FTE"]),
 EUR_PER_YEAR:unit("EUR_PER_YEAR","EUR/Jahr",["€/Jahr"]),
 EUR_PER_WEEK:unit("EUR_PER_WEEK","EUR/Woche",["€/Woche"]),
});

const rule=(parameterKey,label,unitIds,{numeric=true,defaultUnitId=unitIds[0]}={})=>Object.freeze({
 parameterKey,label,units:Object.freeze(unitIds.map(id=>units[id])),defaultUnitId,numeric,
 allowedUnitIds:Object.freeze([...unitIds]),
});

export const parameterUnitRules=Object.freeze({
 C01:rule("C01","Grundlohn",["EUR_PER_HOUR"]),
 C02:rule("C02","Tarifgrundlage",["TARIFF_AGREEMENT_DATE"],{numeric:false}),
 C03:rule("C03","Zuschläge",["PERCENT_BY_TYPE"],{numeric:false}),
 C04:rule("C04","Arbeitgebernebenkosten",["PERCENT"]),
 C05:rule("C05","Urlaubsreserve",["PERCENT"]),
 C06:rule("C06","Krankheitsreserve",["PERCENT"]),
 C07:rule("C07","Ausfallreserve",["PERCENT"]),
 C08:rule("C08","Verwaltungskosten",["PERCENT","EUR"]),
 C09:rule("C09","Objektleitung",["EUR_PER_HOUR","PERCENT"]),
 C10:rule("C10","Einsatzleitung",["EUR_PER_HOUR","PERCENT"]),
 C11:rule("C11","Material",["EUR_PER_UNIT","EUR_PER_OBJECT"]),
 C12:rule("C12","Geräte",["EUR_PER_HOUR","EUR_PER_MONTH"]),
 C13:rule("C13","Fahrzeuge",["EUR_PER_KM","EUR_PER_HOUR","EUR_PER_MONTH"]),
 C14:rule("C14","Fahrtkosten",["EUR_PER_KM","EUR_PER_HOUR"]),
 C15:rule("C15","Personalbeschaffung",["EUR_PER_FTE","PERCENT"]),
 C16:rule("C16","Nachunternehmer",["EUR_PER_UNIT","PERCENT"]),
 C17:rule("C17","Versicherungen",["EUR_PER_YEAR","PERCENT"]),
 C18:rule("C18","Risiko",["PERCENT"]),
 C19:rule("C19","Ziel-DB1",["PERCENT","EUR"]),
 C20:rule("C20","Ziel-DB2",["PERCENT","EUR"]),
 C21:rule("C21","Ziel-DB3",["PERCENT","EUR"]),
 S01:rule("S01","Videoanlage – Kostenansatz / Einheitspreis",["EUR_PER_UNIT"]),
 S02:rule("S02","Anlagenwoche – Kostenansatz / Einheitspreis",["EUR_PER_WEEK"]),
 S03:rule("S03","Notruf-/Servicewoche – Kostenansatz / Einheitspreis",["EUR_PER_WEEK"]),
 S04:rule("S04","Baustellenausstattung – Kostenansatz / Einheitspreis",["EUR"]),
});

export function normalizeUnit(parameterKey,input){
 const definition=parameterUnitRules[parameterKey];
 if(!definition)return null;
 const normalized=normalizeText(input);
 return definition.units.find(candidate=>candidate.aliases.some(alias=>normalizeText(alias)===normalized))||null;
}

export function normalizeDecimal(value){
 if(typeof value==="number")return Number.isFinite(value)?value:null;
 const text=String(value??"").normalize("NFKC").trim();
 if(!/^-?\d+(?:[.,]\d+)?$/.test(text))return null;
 const number=Number(text.replace(",","."));
 return Number.isFinite(number)?number:null;
}

export function unitValidation(parameterKey,input){
 const definition=parameterUnitRules[parameterKey];
 if(!definition)return {unit:null,error:null};
 const canonicalUnit=normalizeUnit(parameterKey,input);
 if(canonicalUnit)return {unit:canonicalUnit,error:null};
 const labels=definition.units.map(candidate=>candidate.label);
 const allowed=labels.length===1?`ausschließlich die Einheit ${labels[0]}`:`ausschließlich ${labels.slice(0,-1).join(", ")} oder ${labels.at(-1)}`;
 return {unit:null,error:{code:"unit_mismatch",message:`Für ${parameterKey} – ${definition.label} ist ${allowed} zulässig.`}};
}
