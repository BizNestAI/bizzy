import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {formatTaxCurrency} from '../src/components/Tax/taxCurrency.js';
import {formatMoney as planningMoney} from '../src/components/Tax/Planning/taxPlanningDisplay.js';
import {formatMoney as explanationMoney} from '../src/components/Tax/Explanations/taxExplanationDisplay.js';
test('Tax estimates share whole-dollar display precision without changing exact amounts',()=>{
 const exact=3934.47;
 for(const formatter of [formatTaxCurrency,planningMoney,explanationMoney]){assert.equal(formatter(exact),'$3,934');assert.equal(formatter(2869.6),'$2,870');assert.equal(formatter(0),'$0');}
 assert.equal(exact,3934.47);assert.equal(formatTaxCurrency(null),'—');
 const dashboard=readFileSync(new URL('../src/pages/Tax/TaxDashboard.jsx',import.meta.url),'utf8');
 assert.match(dashboard,/formatTaxCurrency as formatCurrencyLocal/);
 assert.doesNotMatch(dashboard,/mileageAction=|Mileage deduction<\/button>/);
 const panel=readFileSync(new URL('../src/components/Tax/BusinessMileagePanel.jsx',import.meta.url),'utf8');assert.match(panel,/formatTaxCurrency as money/);
});
