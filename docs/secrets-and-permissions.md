# Secrets and permissions checklist

Add these six **repository Actions secrets to playwright-ci-runner**. They are
only passed to the steps that use them. Check out only reviewed source code; npm
scripts and tests execute on the runner. Limit who can change either repository's
protected branches, source-ref variable and workflow files.

| Secret | Value and required permissions |
| --- | --- |
| `CROSS_REPO_PAT` | GitHub fine-grained PAT restricted to `TCOE-Playwright`, **Contents: Read-only**, with the token owner able to read it. Metadata read access is automatic. A classic PAT for a private source needs `repo`; prefer fine-grained. Approve/authorize for the organization and SSO where applicable. |
| `XRAY_CLIENT_ID` | Client ID from **Xray Global Settings > API Keys**, created for the integration user on the correct Cloud tenant. Not a Jira API token. |
| `XRAY_CLIENT_SECRET` | Matching Xray client secret. Xray API keys inherit their user's permissions, rather than GitHub/OAuth-style selectable scopes. Grant Browse Projects and issue-security visibility for all involved Tests/Plan/Execution, Edit Issues for associations, and Resolve Issues for execution. Keep Tests and Executions in statuses that allow execution. |
| `JIRA_DOMAIN` | Tenant name (`your-company`) or host (`your-company.atlassian.net`). No `https://`, path, port or trailing slash. |
| `JIRA_USER_EMAIL` | Email of the Jira account that owns the attachment API token. |
| `JIRA_API_TOKEN` | An **unscoped Atlassian account API token**, used with Basic email:token authentication at the tenant URL. The user needs **Browse Projects** and **Create attachments**, and visibility under issue security. Enable attachments and check their size limit. |

For existing Tests and an existing Execution, this runner does not intentionally
create Jira issues through Xray. The Jira Automation actor needs **Create Issues**;
grant that to an Xray integration user only if your import policy also permits
automatic Test creation. Check local workflow restrictions and required fields.
Xray's [permission guide](https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/1203503118)
and [execution requirements](https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/44565122)
describe these permission boundaries.

Scoped Atlassian API tokens require a different API gateway URL and are **not
supported by this tenant-URL implementation**. Do not confuse token scopes with
Jira project permissions. If adapting to scoped/OAuth access, Jira documents
`write:jira-work` (classic OAuth) or the granular combination `read:user:jira`,
`write:attachment:jira`, `read:attachment:jira`, `read:avatar:jira` for attachments;
project permissions still apply. See the
[Jira attachment endpoint](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/#api-rest-api-3-issue-issueidorkey-attachments-post).

## Additional credential held by Jira Automation

Use a **separate GitHub dispatch PAT** in the Automation Authorization header:

- Fine-grained: only `playwright-ci-runner`, **Contents: Read and write**.
- Classic alternative: `repo` scope, as documented for repository dispatch.
- An `Actions: write` permission alone does not authorize repository dispatch.
- The checkout PAT stays read-only and does not need this permission.

GitHub documents these permissions under
[Create a repository dispatch event](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
The workflow's automatic `GITHUB_TOKEN` needs only **contents: read**. Artifact
upload uses the Actions artifact service; no repository write permission is added.

## Variables and local environment

| Name | Location | Purpose |
| --- | --- | --- |
| `SOURCE_REPOSITORY` | Required runner Actions variable | `owner/TCOE-Playwright` |
| `SOURCE_REF` | Optional runner Actions variable | Reviewed commit/tag/branch; default `main` |
| `TEST_PLAN_KEY` | Supplied by dispatch/manual inputs | Existing Plan key |
| `TEST_EXEC_KEY` | Supplied by dispatch/manual inputs | Existing Execution key |
| `SOURCE_DIR` | Optional local environment | Default `tcoe-playwright-repo` |
| `XML_REPORT_PATH` | Optional local environment | Default `tcoe-playwright-repo/results/xray-results.xml` |
| `HTML_REPORT_PATH` | Optional local environment | Default `tcoe-playwright-repo/TCOE-Report/index.html` |
| `GITHUB_OUTPUT` | Automatically provided by Actions | Selection output file; do not configure manually in CI |
| `CI` | Set by workflow | Prevents focused tests, limits workers |
| `XRAY_RUN` | Set by orchestrator for source discovery/execution | Lets the existing framework disable retries specifically for Xray runs |

Rotate expiring PATs/API keys and update their respective stores. Do not commit
`.env` files or tokens. The CLI never logs authentication responses, raw API error
bodies or Authorization headers. Playwright reports may contain application data;
this reference retains GitHub artifacts for 14 days and uses Jira's attachment
retention policy for the uploaded HTML file.
