import { readFile } from "node:fs/promises";
import pg from "pg";

const stop = new Set(`aber alle als auch auf aus bei bis das dem den der des die ein eine einer eines für im in ist mit nach oder sich sie sind und von vom vor wie zu zum zur the and for from into of on or the to with le la les de des du et pour sur avec sowie sowie wird werden wurde wurden durch über unter zwischen vergabe ausschreibung ausschreibungen leistung leistungen lieferung auftrag gegenstand deutschland gmbh mbh stadt landkreis gemeinde los lose rahmenvertrag rahmenvereinbarung`.split(/\s+/));
const languageWords = {
  de: new Set("der die das dem den des ein eine einer eines und oder für von vom mit auf aus bei nach durch über unter leistung lieferung vergabe ausschreibung".split(" ")),
  en: new Set("the and for from with into of on services supply procurement contract works tender".split(" ")),
  fr: new Set("le la les de des du et pour avec sur services travaux marché appel offres".split(" ")),
};
const divisionLabels = {
  "03":"Landwirtschaft, Fischerei und Forstwirtschaft","09":"Mineralölerzeugnisse, Brennstoffe und Energie","14":"Bergbauprodukte","15":"Nahrungsmittel und Getränke","16":"Landwirtschaftsmaschinen","18":"Kleidung und Schuhe","19":"Lederwaren","22":"Drucksachen","24":"Chemische Erzeugnisse","30":"Büromaschinen und Computer","31":"Elektrische Maschinen","32":"Rundfunk, Fernsehen und Telekommunikation","33":"Medizinische Ausrüstung","34":"Transportmittel","35":"Sicherheits-, Feuerwehr- und Polizeiausrüstung","37":"Musikinstrumente und Sportgeräte","38":"Labor- und Präzisionsgeräte","39":"Möbel","41":"Wassererfassung und -aufbereitung","42":"Industriemaschinen","43":"Bergbau- und Baumaschinen","44":"Baustoffe","45":"Bauarbeiten","48":"Softwarepakete","50":"Reparatur und Wartung","51":"Installation","55":"Hotel und Restaurant","60":"Transportdienste","63":"Transporthilfsdienste","64":"Post und Telekommunikation","65":"Versorgungsunternehmen","66":"Finanz- und Versicherungsdienste","70":"Immobiliendienste","71":"Architektur, Bau und Ingenieurwesen","72":"IT-Dienste","73":"Forschung und Entwicklung","75":"Öffentliche Verwaltung, Verteidigung und Sozialversicherung","76":"Öl- und Gasindustrie","77":"Land-, Forst- und Fischereidienste","79":"Unternehmensdienstleistungen","80":"Allgemeine und berufliche Bildung","85":"Gesundheits- und Sozialwesen","90":"Abwasser-, Abfall-, Reinigungs- und Umweltdienste","92":"Erholung, Kultur und Sport","98":"Sonstige gemeinschaftliche Dienste","NONE":"Kein belastbarer CPV-Code",
};
const normalize = value => String(value || "").normalize("NFKC").toLocaleLowerCase("de").replace(/[‐‑–—]/g,"-").replace(/[^\p{L}\p{N}]+/gu," ").trim();
const tokens = value => normalize(value).split(/\s+/).filter(word => word.length >= 3 && !stop.has(word) && !/^\d+$/.test(word));
const increment = (map,key) => map.set(key,(map.get(key)||0)+1);
const sorted = (map,limit=100) => [...map].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],"de")).slice(0,limit).map(([value,documents])=>({value,documents}));
const language = words => {
  const scores=Object.fromEntries(Object.entries(languageWords).map(([key,set])=>[key,words.reduce((sum,word)=>sum+(set.has(word)?1:0),0)]));
  const ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  return ranked[0][1]>0&&ranked[0][1]>ranked[1][1]?ranked[0][0]:"undetermined";
};

const connectionString=process.env.DATABASE_URL||(await readFile(process.env.DATABASE_URL_FILE,"utf8")).trim();
const pool=new pg.Pool({connectionString,max:1,options:"-c default_transaction_read_only=on"});
try {
  const rows=(await pool.query(`SELECT id,source_code,publication_date,cpv_codes,title,left(coalesce(description,''),2000) description
    FROM tender.tenders WHERE data_class='PUBLIC_REAL' AND classification_status='REVIEW_REQUIRED' ORDER BY id`)).rows;
  const bySource=new Map(),byMonth=new Map(),byLanguage=new Map(),byDivision=new Map(),byCode=new Map(),topTokens=new Map(),topBigrams=new Map();
  for(const row of rows){
    increment(bySource,row.source_code);
    const month=row.publication_date instanceof Date?row.publication_date.toISOString().slice(0,7):String(row.publication_date||"unknown").slice(0,7);
    increment(byMonth,`${month}|${row.source_code}`);
    const text=`${row.title||""} ${row.description||""}`,rawWords=normalize(text).split(/\s+/).filter(Boolean),words=tokens(text),lang=language(rawWords);
    increment(byLanguage,`${row.source_code}|${lang}`);
    for(const token of new Set(words))increment(topTokens,token);
    const bigrams=[];for(let i=0;i<words.length-1;i++)bigrams.push(`${words[i]} ${words[i+1]}`);
    for(const bigram of new Set(bigrams))increment(topBigrams,bigram);
    const divisions=new Set(),codes=new Set();
    for(const raw of row.cpv_codes||[]){const digits=String(raw).replace(/\D/g,"");if(!digits)continue;codes.add(digits);if(digits.length>=2)divisions.add(digits.slice(0,2));}
    if(!divisions.size)divisions.add("NONE");
    for(const division of divisions)increment(byDivision,`${row.source_code}|${division}`);
    for(const code of codes)increment(byCode,code);
  }
  const reasons=(await pool.query(`WITH latest AS (SELECT DISTINCT ON(tender_id,company_id,coalesce(lot_key,'')) tender_id,relevance_status,reason
    FROM tender.service_relevance_evaluations ORDER BY tender_id,company_id,coalesce(lot_key,''),created_at DESC)
    SELECT reason,count(DISTINCT tender_id)::int tenders FROM latest WHERE relevance_status='MANUAL_CLASSIFICATION_REQUIRED' GROUP BY reason ORDER BY tenders DESC`)).rows;
  const divisions=sorted(byDivision,200).map(item=>{const [source,division]=item.value.split("|");return {source,division,label:divisionLabels[division]||"Weitere CPV-Hauptgruppe",tenders:item.documents}});
  console.log(JSON.stringify({generatedAt:new Date().toISOString(),population:rows.length,bySource:sorted(bySource,10),byPublicationMonth:sorted(byMonth,100),byLanguage:sorted(byLanguage,20),cpvDivisions:divisions,topCpvCodes:sorted(byCode,100),topTextTokens:sorted(topTokens,100),topTextBigrams:sorted(topBigrams,100),priorReviewReasons:reasons}));
} finally { await pool.end(); }
