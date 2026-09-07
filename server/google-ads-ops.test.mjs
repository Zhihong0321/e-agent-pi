import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdsSafetyError,
  LIMITS,
  assertNoEnabling,
  assertNotServing,
  buildCampaignEdit,
  buildKeywordAdditions,
  buildPause,
  buildSearchCampaignDraft,
  planToOperations,
  validateKeywords,
  validateRsa,
} from "./google-ads-ops.mjs";
import { describeResource, validatePlan } from "./google-ads-schema.mjs";

const draft = {
  customerId: "464-254-9168",
  name: "Solar Leads KL",
  dailyBudget: 50,
  cpcBid: 2,
  adGroupName: "Residential",
  keywords: ["solar panel installation", "solar quote"],
  matchType: "phrase",
  headlines: ["Solar Panels KL", "Free Solar Quote", "Cut Your Bill 70%"],
  descriptions: ["Licensed installers across Klang Valley.", "Get a same-day quotation."],
  finalUrl: "https://eternalgy.me/solar",
};

test("a built campaign is paused at every level and references its own temp ids", () => {
  const { operations, summary } = buildSearchCampaignDraft(draft);

  const campaign = operations.find((op) => op.campaignOperation).campaignOperation.create;
  const adGroup = operations.find((op) => op.adGroupOperation).adGroupOperation.create;
  const ad = operations.find((op) => op.adGroupAdOperation).adGroupAdOperation.create;
  const criteria = operations.filter((op) => op.adGroupCriterionOperation);

  assert.equal(campaign.status, "PAUSED");
  assert.equal(adGroup.status, "PAUSED");
  assert.equal(ad.status, "PAUSED");
  for (const op of criteria) assert.equal(op.adGroupCriterionOperation.create.status, "PAUSED");

  assert.equal(adGroup.campaign, campaign.resourceName);
  assert.equal(campaign.campaignBudget, operations[0].campaignBudgetOperation.create.resourceName);
  assert.equal(criteria.length, 2);
  assert.equal(summary.matchType, "PHRASE");
  assert.equal(operations[0].campaignBudgetOperation.create.amountMicros, "50000000");

  // Required by Google on every campaign create; omitting it fails with an
  // opaque "required field was not present", so pin it here.
  assert.equal(campaign.containsEuPoliticalAdvertising, "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");
});

test("assertNoEnabling finds ENABLED at any depth", () => {
  assert.throws(() => assertNoEnabling([{ campaignOperation: { create: { status: "ENABLED" } } }]), AdsSafetyError);
  assert.throws(() => assertNoEnabling({ a: { b: { c: [{ status: "enabled" }] } } }), AdsSafetyError);
  assert.doesNotThrow(() => assertNoEnabling([{ campaignOperation: { create: { status: "PAUSED" } } }]));
});

test("a serving entity is refused, a paused one is allowed", () => {
  assert.throws(() => assertNotServing("ENABLED", "campaign 'Campaign #1'"), AdsSafetyError);
  assert.doesNotThrow(() => assertNotServing("PAUSED", "campaign x"));
  assert.doesNotThrow(() => assertNotServing(undefined, "campaign x"));
});

test("budget ceiling holds", () => {
  assert.throws(() => buildSearchCampaignDraft({ ...draft, dailyBudget: LIMITS.maxDailyBudget + 1 }), AdsSafetyError);
  assert.throws(() => buildSearchCampaignDraft({ ...draft, dailyBudget: 0 }), AdsSafetyError);
  assert.throws(() => buildSearchCampaignDraft({ ...draft, dailyBudget: -5 }), AdsSafetyError);
});

test("responsive search ad shape is enforced", () => {
  assert.throws(() => validateRsa({ ...draft, headlines: ["only", "two"] }), AdsSafetyError);
  assert.throws(() => validateRsa({ ...draft, descriptions: ["just one"] }), AdsSafetyError);
  assert.throws(
    () => validateRsa({ ...draft, headlines: ["fine", "also fine", "x".repeat(31)] }),
    AdsSafetyError,
    "a 31-character headline must be rejected",
  );
  assert.throws(() => validateRsa({ ...draft, finalUrl: "not a url" }), AdsSafetyError);
  assert.throws(() => validateRsa({ ...draft, path2: "second", path1: "" }), AdsSafetyError);

  const ok = validateRsa(draft);
  assert.equal(ok.headlines.length, 3);
  assert.equal(ok.finalUrl, "https://eternalgy.me/solar");
});

test("keyword validation covers match type, emptiness and caps", () => {
  assert.throws(() => validateKeywords(["x"], "SORT_OF"), AdsSafetyError);
  assert.throws(() => validateKeywords([]), AdsSafetyError);
  assert.throws(() => validateKeywords(Array(LIMITS.maxKeywords + 1).fill("k")), AdsSafetyError);
  assert.deepEqual(validateKeywords([" spaced ", "", "  "], "exact"), { keywords: ["spaced"], matchType: "EXACT" });
});

test("keyword additions are paused and capped", () => {
  const { operations } = buildKeywordAdditions({
    adGroupResourceName: "customers/4642549168/adGroups/1",
    keywords: ["solar"],
    matchType: "BROAD",
  });
  assert.equal(operations[0].adGroupCriterionOperation.create.status, "PAUSED");
  assert.throws(() => buildKeywordAdditions({ adGroupResourceName: "", keywords: ["x"] }), AdsSafetyError);
});

test("campaign edit can reach name and budget but has no path to status", () => {
  const { operations } = buildCampaignEdit({
    campaignResourceName: "customers/4642549168/campaigns/1",
    budgetResourceName: "customers/4642549168/campaignBudgets/1",
    name: "Renamed",
    dailyBudget: 20,
  });
  assert.equal(operations.length, 2);
  assert.equal(operations[0].campaignOperation.updateMask, "name");
  assert.equal(operations[1].campaignBudgetOperation.updateMask, "amount_micros");

  const serialised = JSON.stringify(operations);
  assert.ok(!serialised.includes("ENABLED"), "an edit must never carry ENABLED");
  assert.ok(!serialised.includes("status"), "status is not a reachable field on edits");

  assert.throws(() => buildCampaignEdit({ campaignResourceName: "x" }), AdsSafetyError, "an empty edit is refused");
  assert.throws(
    () => buildCampaignEdit({ campaignResourceName: "x", dailyBudget: 10 }),
    AdsSafetyError,
    "a budget change without the budget resource name is refused",
  );
});

test("pausing is always available", () => {
  const { operations } = buildPause({ campaignResourceName: "customers/4642549168/campaigns/1" });
  assert.equal(operations[0].campaignOperation.update.status, "PAUSED");
  assert.doesNotThrow(() => assertNoEnabling(operations));
});

test("planToOperations orders by dependency and injects PAUSED", () => {
  const plan = {
    entities: [
      { ref: "ad", resource: "AdGroupAd", fields: { adGroup: "@ag", ad: { finalUrls: ["https://x.test/"] } } },
      { ref: "ag", resource: "AdGroup", fields: { name: "AG", campaign: "@c" } },
      { ref: "c", resource: "Campaign", fields: { name: "C", campaignBudget: "@b" } },
      { ref: "b", resource: "CampaignBudget", fields: { name: "B", amountMicros: "1000000" } },
    ],
  };
  const { operations, summary } = planToOperations(plan, { customerId: "464-254-9168" });

  assert.deepEqual(
    summary.entities.map((e) => e.resource),
    ["CampaignBudget", "Campaign", "AdGroup", "AdGroupAd"],
    "a budget must be created before the campaign that references it",
  );

  const campaign = operations.find((op) => op.campaignOperation).campaignOperation.create;
  assert.equal(campaign.status, "PAUSED", "an omitted status must become PAUSED, never Google's ENABLED default");
  assert.equal(campaign.campaignBudget, "customers/4642549168/campaignBudgets/-1", "@refs resolve to temp names");

  const budget = operations[0].campaignBudgetOperation.create;
  assert.equal(budget.status, undefined, "CampaignBudget has no status field, so none is injected");
});

test("a plan may not ask for any status but PAUSED", () => {
  const withEnabled = {
    entities: [{ ref: "c", resource: "Campaign", fields: { name: "C", status: "ENABLED" } }],
  };
  assert.throws(() => planToOperations(withEnabled, { customerId: "1" }), AdsSafetyError);

  const withRemoved = {
    entities: [{ ref: "c", resource: "Campaign", fields: { name: "C", status: "REMOVED" } }],
  };
  assert.throws(() => planToOperations(withRemoved, { customerId: "1" }), AdsSafetyError);
});

test("validatePlan catches bad enums, unknown fields, dangling refs and ENABLED", () => {
  const result = validatePlan({
    entities: [
      { ref: "b", resource: "CampaignBudget", fields: { name: "B", amountMicros: "1" } },
      {
        ref: "c",
        resource: "Campaign",
        fields: {
          name: "C",
          advertisingChannelType: "NOPE",
          campaignBudget: "@missing",
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          bogusField: 1,
          status: "ENABLED",
        },
      },
    ],
  });
  assert.equal(result.ok, false);
  const joined = result.errors.join("\n");
  assert.match(joined, /advertisingChannelType/);
  assert.match(joined, /@missing/);
  assert.match(joined, /bogusField/);
  assert.match(joined, /status/);
});

test("validatePlan accepts a complete valid plan", () => {
  const result = validatePlan({
    entities: [
      { ref: "b", resource: "CampaignBudget", fields: { name: "B", amountMicros: "20000000" } },
      {
        ref: "c",
        resource: "Campaign",
        fields: {
          name: "C",
          advertisingChannelType: "SEARCH",
          campaignBudget: "@b",
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          networkSettings: { targetGoogleSearch: true },
        },
      },
    ],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("the schema exposes real fields and enum values offline", () => {
  const campaign = describeResource("Campaign");
  assert.ok(Object.keys(campaign.fields).length > 50, "Campaign should expose its full field set");
  assert.ok(campaign.required.includes("containsEuPoliticalAdvertising"));

  const channel = campaign.fields.advertisingChannelType;
  assert.equal(channel.type, "enum");
  const values = channel.values.map((v) => v.value);
  assert.ok(values.includes("SEARCH") && values.includes("PERFORMANCE_MAX"));
  assert.ok(!values.includes("UNSPECIFIED"), "placeholder enum members must be stripped");

  const nested = describeResource("Campaign", { field: "networkSettings" });
  assert.ok("targetGoogleSearch" in nested.fields);

  assert.throws(() => describeResource("NotAResource"));
});

test("only referenceable resources get a temp resource name", () => {
  const plan = {
    entities: [
      { ref: "b", resource: "CampaignBudget", fields: { name: "B", amountMicros: "1000000" } },
      { ref: "c", resource: "Campaign", fields: { name: "C", campaignBudget: "@b" } },
      { ref: "ag", resource: "AdGroup", fields: { name: "AG", campaign: "@c" } },
      { ref: "kw", resource: "AdGroupCriterion", fields: { adGroup: "@ag", keyword: { text: "k", matchType: "PHRASE" } } },
      { ref: "ad", resource: "AdGroupAd", fields: { adGroup: "@ag", ad: { finalUrls: ["https://x.test/"] } } },
    ],
  };
  const { operations } = planToOperations(plan, { customerId: "4642549168" });

  const byKey = Object.fromEntries(operations.map((op) => [Object.keys(op)[0], Object.values(op)[0].create]));

  // Google rejects a negative temp id on composite-named resources with
  // BAD_RESOURCE_ID, so these must be created without a resourceName at all.
  assert.equal(byKey.adGroupCriterionOperation.resourceName, undefined);
  assert.equal(byKey.adGroupAdOperation.resourceName, undefined);

  assert.equal(byKey.campaignBudgetOperation.resourceName, "customers/4642549168/campaignBudgets/-1");
  assert.equal(byKey.campaignOperation.resourceName, "customers/4642549168/campaigns/-2");
  assert.equal(byKey.adGroupOperation.resourceName, "customers/4642549168/adGroups/-3");
  assert.equal(byKey.adGroupCriterionOperation.adGroup, "customers/4642549168/adGroups/-3");
});

test("pointing at a non-referenceable entity fails with a useful message", () => {
  const plan = {
    entities: [
      { ref: "kw", resource: "AdGroupCriterion", fields: { adGroup: "@ag", keyword: { text: "k" } } },
      { ref: "ad", resource: "AdGroupAd", fields: { adGroup: "@kw" } },
    ],
  };
  assert.throws(() => planToOperations(plan, { customerId: "1" }), /cannot be referenced/);
});
