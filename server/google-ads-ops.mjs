// Pure operation builders and validators for Google Ads writes.
//
// The one invariant this module exists to enforce: **nothing this agent creates
// or touches can ever serve an ad.** That is a property of the code, not of the
// role prompt, because a prompt can be argued out of a rule and a thrown
// exception cannot.
//
// Three rules implement it:
//   1. Everything is created PAUSED. Status is hardcoded, never a parameter.
//   2. No operation may set status ENABLED — assertNoEnabling scans every
//      payload, including edits, and throws on sight.
//   3. Currently-serving entities are off limits. Editing a live campaign
//      changes live spending, so the agent must pause it first (by hand).
//
// No I/O here — everything is a plain object, so it is all unit-testable.

import { CREATE_ORDER, OPERATION_KEYS, RESOURCE_PATHS, resolveRoot } from "./google-ads-schema.mjs";

/** Resources that carry a status field, and so need PAUSED injected on create. */
const STATUS_BEARING = new Set(["Campaign", "AdGroup", "AdGroupAd", "AdGroupCriterion", "AssetGroup"]);

/**
 * Resources whose resource name is a single numeric id, so a negative temp id
 * is valid and other entities can point at them. AdGroupCriterion, AdGroupAd
 * and CampaignCriterion use composite names and are excluded.
 */
const TEMP_NAMEABLE = new Set(["CampaignBudget", "Campaign", "AdGroup", "AssetGroup"]);

/** Overridable ceiling, but a ceiling regardless: an unset env cannot remove it. */
export const LIMITS = {
  maxDailyBudget: Number(process.env.GOOGLE_ADS_MAX_DAILY_BUDGET) || 200,
  maxOperations: 200,
  headline: { min: 3, max: 15, chars: 30 },
  description: { min: 2, max: 4, chars: 90 },
  pathChars: 15,
  keywordChars: 80,
  maxKeywords: 100,
};

const MATCH_TYPES = new Set(["EXACT", "PHRASE", "BROAD"]);

export class AdsSafetyError extends Error {}

function bad(message) {
  throw new AdsSafetyError(message);
}

/**
 * Walks an arbitrary operation payload looking for anything that would put an
 * entity into a serving state. Deep, because status can sit at any nesting depth.
 */
export function assertNoEnabling(value, path = "operation") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEnabling(item, `${path}[${index}]`));
    return value;
  }
  if (!value || typeof value !== "object") return value;

  for (const [key, child] of Object.entries(value)) {
    if (key === "status" && typeof child === "string" && child.toUpperCase() === "ENABLED") {
      bad(
        `Refused: ${path}.status would be set to ENABLED. This agent can never make anything serve — create it paused and enable it yourself in the Google Ads UI.`,
      );
    }
    assertNoEnabling(child, `${path}.${key}`);
  }
  return value;
}

/**
 * Editing something that is already serving changes live spending, which is the
 * one thing this agent must never do. Callers pass the status they just read.
 */
export function assertNotServing(status, what) {
  if (String(status || "").toUpperCase() === "ENABLED") {
    bad(
      `Refused: ${what} is currently ENABLED and serving. This agent only works on paused entities — pause it in the Google Ads UI first, then ask again.`,
    );
  }
}

export function assertOperationCount(operations) {
  if (!operations.length) bad("Nothing to do — the operation list is empty.");
  if (operations.length > LIMITS.maxOperations) {
    bad(`Refused: ${operations.length} operations exceeds the ${LIMITS.maxOperations} cap for a single call.`);
  }
  return operations;
}

export function toMicros(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) bad(`"${amount}" is not a positive amount.`);
  return String(Math.round(value * 1_000_000));
}

export function assertBudget(daily) {
  const value = Number(daily);
  if (!Number.isFinite(value) || value <= 0) bad(`Daily budget must be a positive number, got "${daily}".`);
  if (value > LIMITS.maxDailyBudget) {
    bad(`Refused: daily budget ${value} exceeds the ${LIMITS.maxDailyBudget} cap. Raise GOOGLE_ADS_MAX_DAILY_BUDGET only deliberately.`);
  }
  return value;
}

function assertText(list, kind, rules) {
  const items = (list || []).map((text) => String(text ?? "").trim()).filter(Boolean);
  if (items.length < rules.min) bad(`A responsive search ad needs at least ${rules.min} ${kind}s, got ${items.length}.`);
  if (items.length > rules.max) bad(`A responsive search ad allows at most ${rules.max} ${kind}s, got ${items.length}.`);
  const tooLong = items.filter((text) => text.length > rules.chars);
  if (tooLong.length) {
    bad(`These ${kind}s exceed the ${rules.chars}-character limit: ${tooLong.map((t) => `"${t}" (${t.length})`).join(", ")}`);
  }
  return items;
}

function assertUrl(finalUrl) {
  let parsed;
  try {
    parsed = new URL(String(finalUrl));
  } catch {
    return bad(`"${finalUrl}" is not a valid URL. Include the scheme, e.g. https://example.com/page.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") bad("The final URL must be http or https.");
  return parsed.toString();
}

/** Validates the parts of a responsive search ad and returns the cleaned copy. */
export function validateRsa({ headlines, descriptions, finalUrl, path1, path2 }) {
  const clean = {
    headlines: assertText(headlines, "headline", LIMITS.headline),
    descriptions: assertText(descriptions, "description", LIMITS.description),
    finalUrl: assertUrl(finalUrl),
    path1: String(path1 ?? "").trim(),
    path2: String(path2 ?? "").trim(),
  };
  for (const [name, value] of [["path1", clean.path1], ["path2", clean.path2]]) {
    if (value.length > LIMITS.pathChars) bad(`${name} "${value}" exceeds the ${LIMITS.pathChars}-character limit.`);
  }
  if (!clean.path1 && clean.path2) bad("path2 cannot be used without path1.");
  return clean;
}

export function validateKeywords(keywords, matchType = "PHRASE") {
  const type = String(matchType).toUpperCase();
  if (!MATCH_TYPES.has(type)) bad(`Match type must be one of ${[...MATCH_TYPES].join(", ")}, got "${matchType}".`);

  const items = (keywords || []).map((text) => String(text ?? "").trim()).filter(Boolean);
  if (!items.length) bad("No keywords given.");
  if (items.length > LIMITS.maxKeywords) bad(`Refused: ${items.length} keywords exceeds the ${LIMITS.maxKeywords} cap.`);
  const tooLong = items.filter((text) => text.length > LIMITS.keywordChars);
  if (tooLong.length) bad(`These keywords exceed ${LIMITS.keywordChars} characters: ${tooLong.join(", ")}`);
  return { keywords: items, matchType: type };
}

// Temporary resource names let one atomic mutate reference entities it is
// creating in the same call. Negative ids are the API's convention for these.
const tempName = (customerId, resource, index) => `customers/${customerId}/${resource}/-${index}`;

/**
 * Builds every operation for a complete, paused Search campaign: budget,
 * campaign, ad group, keywords and one responsive search ad.
 */
export function buildSearchCampaignDraft({
  customerId,
  name,
  dailyBudget,
  adGroupName,
  cpcBid,
  keywords,
  matchType,
  headlines,
  descriptions,
  finalUrl,
  path1,
  path2,
}) {
  const cid = String(customerId || "").replace(/-/g, "");
  if (!cid) bad("No customer ID.");
  const campaignName = String(name ?? "").trim();
  if (!campaignName) bad("The campaign needs a name.");

  const budget = assertBudget(dailyBudget);
  const bid = assertBudget(cpcBid ?? 1); // a CPC bid is capped by the same ceiling
  const ad = validateRsa({ headlines, descriptions, finalUrl, path1, path2 });
  const { keywords: terms, matchType: type } = validateKeywords(keywords, matchType);

  const budgetRef = tempName(cid, "campaignBudgets", 1);
  const campaignRef = tempName(cid, "campaigns", 2);
  const adGroupRef = tempName(cid, "adGroups", 3);

  const operations = [
    {
      campaignBudgetOperation: {
        create: {
          resourceName: budgetRef,
          // Budget names must be unique in the account, hence the timestamp.
          name: `${campaignName} budget ${Date.now()}`,
          amountMicros: toMicros(budget),
          deliveryMethod: "STANDARD",
          explicitlyShared: false,
        },
      },
    },
    {
      campaignOperation: {
        create: {
          resourceName: campaignRef,
          name: campaignName,
          status: "PAUSED", // hardcoded, never a parameter
          advertisingChannelType: "SEARCH",
          // Required on every campaign create since the EU political ads rules.
          // Declaring otherwise would be a compliance statement no agent should make.
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          campaignBudget: budgetRef,
          manualCpc: { enhancedCpcEnabled: false },
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: false,
          },
        },
      },
    },
    {
      adGroupOperation: {
        create: {
          resourceName: adGroupRef,
          name: String(adGroupName ?? "").trim() || `${campaignName} ad group`,
          campaign: campaignRef,
          status: "PAUSED",
          type: "SEARCH_STANDARD",
          cpcBidMicros: toMicros(bid),
        },
      },
    },
    ...terms.map((text) => ({
      adGroupCriterionOperation: {
        create: {
          adGroup: adGroupRef,
          status: "PAUSED",
          keyword: { text, matchType: type },
        },
      },
    })),
    {
      adGroupAdOperation: {
        create: {
          adGroup: adGroupRef,
          status: "PAUSED",
          ad: {
            finalUrls: [ad.finalUrl],
            responsiveSearchAd: {
              headlines: ad.headlines.map((text) => ({ text })),
              descriptions: ad.descriptions.map((text) => ({ text })),
              ...(ad.path1 ? { path1: ad.path1 } : {}),
              ...(ad.path2 ? { path2: ad.path2 } : {}),
            },
          },
        },
      },
    },
  ];

  assertOperationCount(operations);
  assertNoEnabling(operations);

  return {
    operations,
    summary: {
      campaign: campaignName,
      dailyBudget: budget,
      cpcBid: bid,
      adGroup: operations[2].adGroupOperation.create.name,
      keywords: terms,
      matchType: type,
      headlines: ad.headlines,
      descriptions: ad.descriptions,
      finalUrl: ad.finalUrl,
    },
  };
}

/** Adds keywords to an ad group that already exists. Caller must have checked it is paused. */
export function buildKeywordAdditions({ adGroupResourceName, keywords, matchType }) {
  if (!adGroupResourceName) bad("No ad group resource name.");
  const { keywords: terms, matchType: type } = validateKeywords(keywords, matchType);
  const operations = terms.map((text) => ({
    adGroupCriterionOperation: {
      create: { adGroup: adGroupResourceName, status: "PAUSED", keyword: { text, matchType: type } },
    },
  }));
  assertOperationCount(operations);
  assertNoEnabling(operations);
  return { operations, summary: { adGroup: adGroupResourceName, keywords: terms, matchType: type } };
}

/**
 * Edits a paused campaign. Only name and budget are reachable — status is
 * deliberately absent from the field map, so no argument can ever change it.
 */
export function buildCampaignEdit({ campaignResourceName, budgetResourceName, name, dailyBudget }) {
  if (!campaignResourceName) bad("No campaign resource name.");
  const operations = [];
  const summary = { campaign: campaignResourceName };

  const nextName = String(name ?? "").trim();
  if (nextName) {
    operations.push({
      campaignOperation: { update: { resourceName: campaignResourceName, name: nextName }, updateMask: "name" },
    });
    summary.name = nextName;
  }

  if (dailyBudget != null) {
    if (!budgetResourceName) bad("Changing the budget needs the campaign's budget resource name.");
    const budget = assertBudget(dailyBudget);
    operations.push({
      campaignBudgetOperation: {
        update: { resourceName: budgetResourceName, amountMicros: toMicros(budget) },
        updateMask: "amount_micros",
      },
    });
    summary.dailyBudget = budget;
  }

  if (!operations.length) bad("Nothing to change — give a new name, a new daily budget, or both.");
  assertNoEnabling(operations);
  return { operations, summary };
}

/**
 * Core 2: turn a validated plan into one atomic batch of create operations.
 *
 * The plan is authored entirely offline (server/google-ads-schema.mjs). This is
 * the only place it meets the API shape, and the safety rules are applied here
 * too — notably injecting PAUSED wherever the plan omitted a status, because
 * Google's own default for a new campaign is ENABLED.
 */
export function planToOperations(plan, { customerId }) {
  const cid = String(customerId || "").replace(/-/g, "");
  if (!cid) bad("No customer ID.");

  const entities = Array.isArray(plan?.entities) ? plan.entities : bad("The plan needs an 'entities' array.");
  const order = new Map(CREATE_ORDER.map((name, index) => [name, index]));

  const resolved = entities.map((entity) => {
    const root = resolveRoot(entity?.resource);
    if (!root) bad(`Unknown resource "${entity?.resource}".`);
    if (!entity.ref) bad("Every entity needs a 'ref'.");
    return { ...entity, resource: root.name };
  });

  const unknown = resolved.filter((e) => !order.has(e.resource));
  if (unknown.length) bad(`These resources cannot be created in a plan: ${unknown.map((e) => e.resource).join(", ")}.`);

  // Dependency order by resource kind, stable within a kind.
  resolved.sort((a, b) => order.get(a.resource) - order.get(b.resource));

  // Only resources with a simple numeric id can carry a negative temp name.
  // AdGroupCriterion and AdGroupAd use composite names (adGroupId~criterionId),
  // and Google rejects a temp id for them outright — nothing references them
  // anyway, so they are created without a resourceName.
  const tempNames = new Map();
  let counter = 0;
  for (const entity of resolved) {
    if (!TEMP_NAMEABLE.has(entity.resource)) continue;
    counter += 1;
    tempNames.set(entity.ref, `customers/${cid}/${RESOURCE_PATHS[entity.resource]}/-${counter}`);
  }

  const resolveRefs = (value) => {
    if (Array.isArray(value)) return value.map(resolveRefs);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v)]));
    }
    if (typeof value === "string") {
      const match = /^@([A-Za-z0-9_-]+)$/.exec(value);
      if (match) {
        const target = tempNames.get(match[1]);
        if (!target) {
          const known = [...tempNames.keys()].map((r) => `@${r}`).join(", ") || "none";
          bad(
            `"@${match[1]}" cannot be referenced. Only ${[...TEMP_NAMEABLE].join(", ")} entities can be pointed at; referenceable here: ${known}.`,
          );
        }
        return target;
      }
    }
    return value;
  };

  const operations = resolved.map((entity) => {
    const create = resolveRefs({ ...entity.fields });
    const temp = tempNames.get(entity.ref);
    if (temp) create.resourceName = temp;

    // Only inject where the resource actually has a status field.
    if (STATUS_BEARING.has(entity.resource)) {
      if (create.status === undefined) create.status = "PAUSED";
      else if (String(create.status).toUpperCase() !== "PAUSED") {
        bad(
          `Refused: @${entity.ref} (${entity.resource}) sets status "${create.status}". Plans may only create paused entities.`,
        );
      }
    }
    return { [OPERATION_KEYS[entity.resource]]: { create } };
  });

  assertOperationCount(operations);
  assertNoEnabling(operations);

  return {
    operations,
    summary: {
      entities: resolved.map((e) => ({ ref: e.ref, resource: e.resource, resourceName: tempNames.get(e.ref) || null })),
      operations: operations.length,
    },
  };
}

/** Pausing is always allowed: it can only ever reduce spend, never create it. */
export function buildPause({ campaignResourceName }) {
  if (!campaignResourceName) bad("No campaign resource name.");
  return {
    operations: [
      {
        campaignOperation: { update: { resourceName: campaignResourceName, status: "PAUSED" }, updateMask: "status" },
      },
    ],
    summary: { campaign: campaignResourceName, status: "PAUSED" },
  };
}
