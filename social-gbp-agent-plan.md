# Social & Google Business Profile (GBP) AI Agent SaaS — Architecture & Platform Approval Plan

Status: Planning & Feasibility. Written 2026-10-03.

---

## 1. Executive Summary & Complexity Rating

| Platform | Verification Difficulty | Core Prerequisites | Realistic Approval Time | Direct Platform Fee |
|---|---|---|---|---|
| **Meta Graph API (FB Pages & IG)** | **Medium-High** (Procedural & Document-heavy) | Registered legal entity (LLC/Corp/Sole Prop), Utility bill or bank statement, live screencasts of each feature | **1 – 3 weeks** | **$0 (Free)** |
| **Google Business Profile (GBP) API** | **High** (Strict manual gatekeeping) | Dedicated GBP API Quota Access Request, verified company domain, Search Console verification, OAuth consent audit | **2 – 6 weeks** (Appeals often needed) | **$0 (Free)** (Sensitive scope, no CASA audit fee) |
| **Google Cloud OAuth Public Verification** | **Medium** (Standard compliance) | Privacy Policy, Terms of Service, YouTube unlisted walkthrough video showing OAuth prompt | **3 – 7 business days** | **$0 (Free)** |

---

## 2. API Deep-Dive & Approval Breakdown

### 2.1 Meta Graph API (Facebook & Instagram)

Meta provides the Graph API to manage Facebook Pages and Instagram Professional Accounts (Business or Creator).

#### Required Permissions Matrix
* **Facebook Pages**:
  * `pages_show_list`: Retrieve pages managed by the user.
  * `pages_read_engagement`: Monitor comments, engagement, and page statistics.
  * `pages_manage_posts`: Create, schedule, and publish posts, photos, and videos.
  * `pages_manage_metadata`: Register Webhooks for real-time comment and post events.
* **Instagram Business / Creator Accounts**:
  * `instagram_basic`: Read profile info and media list.
  * `instagram_content_publish`: Direct publishing of Single Image, Carousel (up to 10 slides), and Reels.
  * `instagram_manage_comments`: AI comment moderation, sentiment triage, and direct replies.
  * `instagram_manage_insights`: Analytics on reach, impressions, and follower growth.

#### Meta Approval Process & Step-by-Step Checklist
1. **Meta Business Account (Business Manager) Verification**:
   * *Required Documents*: Certificate of Incorporation / Business Registration, Government Tax document, and a recent utility bill or bank statement with matching legal business name and registered address.
   * *Identity Check*: Personal ID verification (Driver's License or Passport) of the Business Manager admin.
2. **Facebook Login for Business Integration**:
   * Set up configuration in `developers.facebook.com`.
   * Configure App Domains, Privacy Policy URL, Terms of Service URL, and Data Deletion Callback URL.
3. **App Review Submission**:
   * For **each** permission requested (e.g. `pages_manage_posts`, `instagram_content_publish`), you must upload:
     1. A concise, unedited 1–2 minute screen recording (MP4/WebM) demonstrating how a user connects their account, drafts an AI post, and how it publishes to Facebook or Instagram.
     2. Detailed text prompt explaining the business justification (e.g., *"Our SaaS allows verified local businesses to automate cross-platform social scheduling and AI customer service"*).
     3. Dedicated test account credentials or guidance for Meta reviewers.
4. **Development Mode Workaround (Build Without Waiting)**:
   * While the app is in `Development Mode`, any developer, admin, or invited tester can execute all API calls without approval.
   * **Action**: Build and polish the entire UI and AI posting pipeline using internal test pages first, then record the required screencasts directly from the working app.

#### Fee Schedule for Meta
* **Meta for Developers Account**: **$0** (No developer enrollment fee).
* **Meta Business Verification**: **$0** (Meta does not charge to verify corporate documents).
* **Graph API Usage (Organic Post & Read)**: **$0** (Included with standard rate limits of 200 calls/user/hour).
* **Indirect / Infrastructure Costs**: Legal entity registration (if not already incorporated) + Domain and business email hosting.

#### Required Documentation for Meta
1. **Legal Business Verification (2 documents required)**:
   * **Proof of Legal Entity Name**: Certificate of Incorporation / Business Registration Certificate (e.g. Form 9, SSM, ACRA, LLC Certificate) or Official Tax Registration/VAT document.
   * **Proof of Physical Address & Phone**: Recent utility bill (electricity, water, internet) or official bank statement displaying the exact legal business name and registered address (dated within 90 days).
2. **Domain & Identity Documents**:
   * **Corporate Domain Email**: An email matching the company domain (e.g., `contact@yourdomain.com`). Free consumer webmail (`@gmail.com`) is rejected for business verification.
   * **Admin Government Photo ID**: Passport, National ID, or Driver's License of the Meta Business Manager administrator.
   * **Domain Verification**: DNS TXT record or HTML meta tag verified in Meta Business Manager.
3. **Legal Compliance URLs**:
   * Live HTTPS Website describing the SaaS.
   * Public **Privacy Policy URL** detailing data retention, usage, and sharing.
   * Public **Terms of Service URL**.
   * **User Data Deletion Callback URL** or detailed Data Deletion Instructions URL (mandatory in app settings).

---

### 2.2 Google Business Profile (GBP) & Google Maps API

Managing Google Maps locations and replying to reviews is handled via the **Google Business Profile APIs** (formerly Google My Business).

#### Fee Schedule for Google
* **Google Cloud Project & Console**: **$0** (Free to create and configure).
* **Google Business Profile API**: **$0** (Google does not charge for GBP API requests or quotas).
* **Google Cloud OAuth App Verification**: **$0** (Google does not charge for standard OAuth verification).
* **CASA Security Assessment Clarification**:
  * Unlike Gmail/Drive scopes which are classified as "Restricted" and require a paid external CASA Tier 2/3 lab audit ($3,000–$15,000/yr), the Google Business Profile scope (`https://www.googleapis.com/auth/business.manage`) is classified by Google as **Sensitive**, not Restricted.
  * **Result: $0 Security Audit Fee** — verification is performed directly by Google's Trust & Safety team.

#### Essential APIs & Scopes
* **Scopes**:
  * `https://www.googleapis.com/auth/business.manage`: Grants permissions to read reviews, post review replies, update opening hours/attributes, and publish Local Updates (Posts).
* **Specific Endpoints**:
  * **Business Information API** (`mybusinessbusinessinformation.googleapis.com`): Location details, attributes, address, phone numbers.
  * **Reviews API** (`mybusinessreviews.googleapis.com`):
    * `accounts.locations.reviews.list`: Ingest customer reviews and star ratings.
    * `accounts.locations.reviews.reply`: Publish AI-generated replies directly beneath the user's review on Google Maps.
  * **Account Management API** (`mybusinessaccountmanagement.googleapis.com`): List business accounts and location groups.
  * **Performance API** (`businessprofileperformance.googleapis.com`): Impressions on Search vs Maps, call clicks, direction requests.

#### Required Documentation for Google
1. **Domain & Brand Verification**:
   * Domain ownership verified in **Google Search Console** under the same Google account managing the Google Cloud Console.
   * Active HTTPS website featuring company branding, physical contact details, and support email.
   * Publicly accessible **Privacy Policy** and **Terms of Service** hosted directly on the verified domain.
2. **GBP API Quota Access Request Submission**:
   * Google Cloud Project ID & Project Number.
   * Detailed written explanation addressing:
     1. Why the Google Business web dashboard is insufficient (e.g. multi-location centralized management).
     2. Target customer profile (SMEs, franchise chains, retail/hospitality brands).
     3. Location volume projections for Months 1, 6, and 12.
     4. User authorization architecture (OAuth 2.0 per-location tenant delegation).
     5. AI governance: Explicit assurance that replies are monitored, adhere to Google anti-spam rules, and support human review.
3. **OAuth App Verification Deliverables**:
   * **Unlisted YouTube Demo Video**: Must show the full OAuth consent flow with the `client_id` clearly visible in the browser address bar, the Google permissions prompt, and how the app uses the GBP data (fetching reviews and posting a reply).

## 3. SaaS & AI Agent Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Next.js Frontend (App)                          │
│  - Multi-location Switcher                                             │
│  - AI Content Studio (Copy, Hashtags, Media Resizing)                  │
│  - Review Triage Inbox (Autopilot toggle, Draft & Approve queue)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    API Gateway & Auth Service (Node.js)                │
│  - OAuth Token Vault (Encrypted AES-256 Refresh Tokens)                │
│  - Multi-tenant Organization & Role-based Access Control               │
└──────────────┬────────────────────┬────────────────────┬───────────────┘
               │                    │                    │
               ▼                    ▼                    ▼
     ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
     │  Review Ingestion │  │ AI Agent Engine  │  │ Social Scheduler │
     │  & Webhooks      │  │ (LLM Orchestrator│  │ (Queue / Workers)│
     └─────────┬────────┘  └────────┬─────────┘  └────────┬─────────┘
               │                    │                     │
               ▼                    ▼                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          External Platform APIs                        │
│   • Google Business Profile API (Reviews, Maps info, Local Posts)      │
│   • Facebook Graph API (Page posts, comments, engagement)              │
│   • Instagram Graph API (Publishing Reels/Carousels, comment replies)   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. AI Agent Workflows

### 4.1 Review Responder Agent (Google Maps & Facebook Reviews)
1. **Event Ingestion**: Webhook or 15-minute polling detects a new review.
2. **Classification & Sentiment Pipeline**:
   * *Attributes evaluated*: Star rating (1-5), Sentiment polarity, Keyword mentions (staff, cleanliness, pricing, delay, quality), Language detection.
3. **Dual Routing Engine**:
   * **Route A: Autopilot (Positive 4-5 Stars)**:
     * Generates a warm, authentic response acknowledging specific positive mentions.
     * Injects localized SEO keywords naturally (e.g. *"Glad you enjoyed our artisan sourdough in Subang Jaya!"*).
     * Publishes reply automatically via `locations.reviews.reply`.
   * **Route B: Human-in-the-Loop (Negative 1-3 Stars / Escalations)**:
     * Drafts an empathetic, polite de-escalation reply offering direct manager contact info (phone/email).
     * Flags critical complaints (health/safety, legal threats) for urgent notification via WhatsApp/Email.
     * Places draft in Dashboard for 1-click edit & publish.

### 4.2 Cross-Platform Post Composer Agent
1. **Single Input to Multi-Channel Adaptation**:
   * **Input**: Business topic (e.g., *"Weekend 20% discount on coffee beans and pastry bundles"*).
   * **Instagram Adaptation**:
     * Visual hook, storytelling caption, line breaks, strong CTA, 8–12 curated niche hashtags.
     * Validates aspect ratio: Square 1:1 (1080x1080) or Portrait 4:5 (1080x1350).
   * **Facebook Adaptation**:
     * Engaging discussion prompt, direct link preview or native media, community-oriented tone.
   * **Google Business Update (Local Post)**:
     * High-intent, promotional text with localized SEO keywords.
     * Action button integration: `CALL`, `ORDER`, `BUY`, or `LEARN_MORE`.

---

## 5. Implementation Roadmap

### Phase 1: Local Development & Dev-Mode Engine (Weeks 1–2)
- Set up Meta Developer App in Development Mode with `pages_manage_posts` and `instagram_content_publish`.
- Implement OAuth login for Facebook/Instagram with test Pages.
- Build the AI generation pipeline (Gemini / Claude / GPT) with platform-specific formatting rules.
- Build Review triage system with mock Google review webhooks.

### Phase 2: Compliance, Company Verification & Demos (Weeks 3–4)
- Complete Meta Business Verification by submitting legal company registration and address proof.
- Submit the Google Business Profile API Quota Request form.
- Record 1-2 minute screencast videos showcasing end-to-end user workflows.
- Submit Meta App Review for Facebook & Instagram permissions.

### Phase 3: Production Rollout (Weeks 5–6)
- Switch Meta App to Live Mode.
- Activate verified Google GBP API quota.
- Complete Google OAuth 2.0 public verification.
- Launch multi-tenant onboarding.
