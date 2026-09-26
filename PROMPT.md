Act as a Principal QA Automation and DevOps Engineer. I need you to implement an end-to-end, event-driven test orchestration pipeline connecting Jira Cloud + Xray Cloud to an automated Playwright (TypeScript) test suite hosted across two GitHub repositories.

### Context & System Architecture
1. Source Repository (`TCOE-Playwright`):
   - Contains the core test codebase written in Playwright with TypeScript.
   - Tests are annotated with Jira/Xray issue keys as tags (e.g., `test('Verify login', { tag: ['@PROJ-101'] }, ...)`).
2. Orchestration Repository (`playwright-ci-runner`):
   - A dedicated GitHub repository containing the CI/CD workflows and orchestration logic.
   - Triggered via GitHub's `repository_dispatch` API whenever a Jira Test Plan transitions to status "Execute".
   - Clones `TCOE-Playwright` using a GitHub PAT.
   - Queries Xray Cloud GraphQL API to dynamically retrieve all Test issue keys linked to the specified Test Plan.
   - Executes only the relevant tests using Playwright's `--grep` filter.
   - Sends the JUnit test execution results back to the Xray Cloud API to set individual test statuses (PASS/FAIL).
   - Packages the Playwright HTML report (`playwright-report.zip`) and attaches it directly to the Jira Test Execution issue via the Jira REST API v3.
3. Jira Cloud & Xray Cloud:
   - Automated via Jira Cloud Automation Rules triggered on Test Plan status change.

---

### Your Task & Required Deliverables

Generate clean, production-ready, fully commented code, configuration files, and setup instructions covering all components below:

#### Deliverable 1: `TCOE-Playwright` Configuration
- Provide the exact `playwright.config.ts` configuration required:
  - Configure dual reporters: `html` (output folder: `playwright-report`, never auto-open) and `junit` (output file: `results/xray-results.xml`, configured to map test tags/titles properly for Xray compatibility).
- Provide a minimal reference test file (`tests/example.spec.ts`) demonstrating how tests must be tagged with Jira issue keys (e.g., `@PROJ-101`).

#### Deliverable 2: Orchestration Scripts (`playwright-ci-runner`)
To keep the GitHub Actions workflow clean, maintainable, and robust against shell-escaping bugs, write a modular Node.js orchestration script (`scripts/xray-orchestrator.ts` or `.js`) with zero heavy dependencies (use native `fetch` or standard libraries) to handle:
1. `authenticateXray()`: Authenticates against `https://xray.cloud.getxray.app/api/v2/authenticate` using `XRAY_CLIENT_ID` and `XRAY_CLIENT_SECRET`.
2. `fetchTestKeys(testPlanKey, token)`: Queries Xray Cloud GraphQL API (`https://xray.cloud.getxray.app/api/v2/graphql`) to fetch all test issue keys associated with the Test Plan (handling pagination up to 100+ tests).
3. `buildGrepFilter(testKeys)`: Outputs the regex pattern compatible with Playwright's `--grep` flag (e.g., `@PROJ-101|@PROJ-102`).
4. `importResultsToXray(testExecKey, xmlReportPath, token)`: Uploads the generated JUnit XML report to `https://xray.cloud.getxray.app/api/v2/import/execution/junit?testExecKey=<KEY>`.
5. `uploadReportToJira(testExecKey, zipPath, jiraDomain, jiraEmail, jiraToken)`: Uploads the zipped Playwright HTML report to Jira issue attachments via `POST https://<domain>.atlassian.net/rest/api/3/issue/<testExecKey>/attachments` with `X-Atlassian-Token: no-check`.

#### Deliverable 3: GitHub Actions Workflow (`.github/workflows/run-xray-playwright.yml`)
- Triggered by:
  - `repository_dispatch` (event_type: `execute-xray-tests`) with payload `{ testPlanKey, testExecKey }`.
  - `workflow_dispatch` (manual fallback) accepting `testPlanKey` and `testExecKey` as inputs.
- Workflow steps:
  1. Check out the dedicated runner repository.
  2. Check out `TCOE-Playwright` into a subdirectory (`tcoe-playwright-repo`) using a Personal Access Token (`CROSS_REPO_PAT`).
  3. Set up Node.js 20 with dependency caching.
  4. Install dependencies and Playwright browsers (`npx playwright install --with-deps chromium`).
  5. Fetch test keys via the orchestrator script and export the `--grep` string.
  6. Execute tests (`npx playwright test --grep "<pattern>"`), ensuring subsequent steps execute even if test assertions fail (`continue-on-error: true`).
  7. Import JUnit results into Xray (executed with `if: always()`).
  8. Zip `playwright-report/` and attach `playwright-report.zip` to the Jira Test Execution issue (executed with `if: always()`).
  9. Explicitly fail the workflow if step 6 (the test execution) failed.

#### Deliverable 4: Jira Cloud Automation Configuration Guide
- Provide a step-by-step configuration breakdown for Jira Automation:
  - **Trigger:** Issue transitioned (To: `Execute`, Issue Type: `Test Plan`).
  - **Action 1:** Create Issue (Type: `Test Execution`, linked to the triggering Test Plan).
  - **Action 2:** Send Web Request (`POST` to `https://api.github.com/repos/{owner}/{orchestration-repo}/dispatches`).
  - Provide the exact HTTP Headers, JSON payload, and Jira smart values (`{{issue.key}}`, `{{createdIssue.key}}`).

#### Deliverable 5: Secrets & Permissions Reference
- Provide a complete checklist of all required environment variables/secrets (`CROSS_REPO_PAT`, `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET`, `JIRA_DOMAIN`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`) and their exact required scopes/permissions.

Ensure all scripts have robust error handling, proper HTTP status code validation, and helpful logging.