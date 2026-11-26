import type { LocalMarket } from './local-interest.ts';

const usRegions: Record<string, string> = Object.fromEntries([
  'AL:Alabama', 'AK:Alaska', 'AZ:Arizona', 'AR:Arkansas', 'CA:California', 'CO:Colorado', 'CT:Connecticut', 'DE:Delaware',
  'DC:District of Columbia', 'FL:Florida', 'GA:Georgia', 'HI:Hawaii', 'ID:Idaho', 'IL:Illinois', 'IN:Indiana', 'IA:Iowa',
  'KS:Kansas', 'KY:Kentucky', 'LA:Louisiana', 'ME:Maine', 'MD:Maryland', 'MA:Massachusetts', 'MI:Michigan', 'MN:Minnesota',
  'MS:Mississippi', 'MO:Missouri', 'MT:Montana', 'NE:Nebraska', 'NV:Nevada', 'NH:New Hampshire', 'NJ:New Jersey',
  'NM:New Mexico', 'NY:New York', 'NC:North Carolina', 'ND:North Dakota', 'OH:Ohio', 'OK:Oklahoma', 'OR:Oregon',
  'PA:Pennsylvania', 'RI:Rhode Island', 'SC:South Carolina', 'SD:South Dakota', 'TN:Tennessee', 'TX:Texas', 'UT:Utah',
  'VT:Vermont', 'VA:Virginia', 'WA:Washington', 'WV:West Virginia', 'WI:Wisconsin', 'WY:Wyoming', 'PR:Puerto Rico',
].flatMap(value => { const [code, name] = value.split(':'); return [[code!.toLowerCase(), code!], [name!.toLowerCase(), code!]]; }));

function normalized(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(); }
export function canonicalLocalMarket(market: LocalMarket): LocalMarket {
  const countryCode = market.countryCode.toUpperCase(), region = market.region?.trim();
  return { city: market.city.trim(), countryCode, ...(region ? { region: countryCode === 'US' ? usRegions[normalized(region)] ?? region : region } : {}) };
}
