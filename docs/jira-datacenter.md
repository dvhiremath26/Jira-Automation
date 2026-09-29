# Jira Data Center setup

The runner supports Cloud (default) and Data Center through `JIRA_DEPLOYMENT`.
Data Center mode uses your Jira server's Xray REST API and Jira REST API v2.
Jira Software 10.3.22 alone is insufficient: install and license an Xray Data
Center version compatible with your Jira version. This implementation has offline
API contract tests; it has not yet been verified against your 10.3.22 instance.

## GitHub configuration

In **Jira-Automation > Settings > Secrets and variables > Actions**, configure:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `JIRA_DEPLOYMENT` | `datacenter` |
| Variable | `JIRA_BASE_URL` | Your HTTPS base URL, e.g. `https://jira.example.com` or `https://jira.example.com:8443/jira` |
| Secret | `JIRA_PAT` | Personal access token created on that Jira Data Center instance |
| Variable | `SOURCE_REPOSITORY` | `dvhiremath26/Playwright-Typescript-Framework` |
| Variable | `SOURCE_REF` | Branch or commit containing your mapped tests, e.g. `main` |
| Secret | `CROSS_REPO_PAT` | Existing GitHub token with read access to the source repository |
| Variable, optional | `HTML_REPORT_PATH` | Default `tcoe-playwright-repo/TCOE-Report/index.html` |
| Variable, optional | `RUNNER_LABELS` | JSON array; default `["ubuntu-latest"]`. For an internal server, e.g. `["self-hosted","linux","x64","jira-dc"]` |

Create the Jira PAT under your Jira user profile's **Personal access tokens**.
The token user needs access to the Tests, Plan and Execution, permission to edit
their Xray associations/results, and Create attachments. Check issue security,
workflow restrictions and Xray permissions with your Jira administrator.
Cloud client credentials, `JIRA_DOMAIN`, email and Cloud API token are unused in
Data Center mode. The Jira PAT is passed only to selection/import/attachment steps.
See [Atlassian's PAT documentation](https://developer.atlassian.com/server/jira/platform/personal-access-token/).

One repository configuration targets one Jira deployment. To switch back, set
`JIRA_DEPLOYMENT=cloud` and retain the existing Cloud secrets. Do not switch modes
while a run is active. To operate both simultaneously, use separately configured
runner repositories. Dispatch payloads cannot override server URLs or credentials.

## Network and runner

For an internal Jira server, register a Linux GitHub self-hosted runner with the
labels you configured, network/DNS access to Jira and your application, and
outbound access to GitHub, npm and Playwright downloads. The workflow installs
Chromium system dependencies, so provision a compatible Linux machine and the
necessary installation privileges. Windows runner setup is not included.

Use a dedicated runner for trusted repository code. If your Jira uses a private
certificate authority, configure the runner's trust store and Node's
`NODE_EXTRA_CA_CERTS` environment variable to point to the PEM certificate file
before the runner service starts. Keep certificate verification enabled. The base
URL must be the final HTTPS address; login redirects are rejected.

The Jira server must separately be able to send requests to `api.github.com`.
Configure any administrator-managed outbound allowlist or proxy accordingly.

## First live check

1. Push these runner changes to the GitHub default branch.
2. In Data Center, create Generic Xray Tests and a Test Plan. Use those server's
   issue keys in the Playwright `xray('KEY')` annotations; Cloud keys are not
   automatically migrated. Add the Tests to the Plan.
3. Create one Test Execution manually. Run **Actions > Execute Xray Test Plan >
   Run workflow** with that Plan and Execution's keys.
4. Confirm selected keys in the job log, Execution membership in the Plan's Xray
   panel, per-Test results, and the `index.html` attachment on the Execution.
5. Configure the same trigger/create-Execution/dispatch sequence from the
   [automation guide](jira-automation.md) in Data Center's Automation rule editor.
   Labels can differ by installed Automation version. The JSON payload and GitHub
   dispatch URL are unchanged. Jira holds the separate GitHub dispatch PAT;
   `JIRA_PAT` authenticates the runner back to Jira.

Only `index.html` is attached. JUnit is imported into Xray and preserved as a
GitHub artifact; it is not attached to the issue. Imports do not transition the
Test Plan's Jira workflow status to Executed.

## API behavior and troubleshooting

Plan selection uses numbered REST pages until an empty page, with duplicate and
empty-plan checks. Keep the Plan stable during selection. The requested page size
is 100; your Xray REST maximum must permit it. Repeated pages cause a failure
rather than a partial run; check your Xray version and pagination configuration.
Association writes are verified by reading Plan membership. JUnit is sent as a
multipart file, and the returned Execution key must match the request.

These contracts follow Xray's [Test Plan API](https://getxraydocs.atlassian.net/wiki/spaces/XRAY740/pages/48432416/Test+Plans+-+REST),
[result import API](https://getxraydocs.atlassian.net/wiki/spaces/XRAY630/pages/45844552),
and [JUnit test-key mapping](https://getxraydocs.atlassian.net/wiki/spaces/XRAY/pages/301506710/Taking+advantage+of+JUnit+XML+reports).
HTML upload uses [Jira's attachment API](https://support.atlassian.com/jira/kb/how-to-add-an-attachment-to-a-jira-issue-using-rest-api/).

- 401/403: check PAT expiration, user permissions and Xray license.
- 404: check the context path, Xray installation and issue visibility.
- Network timeout: verify access from the runner machine, not just your laptop.
- JSON response error: check for an SSO/login page or reverse-proxy response.
- An import timeout may have completed server-side. Inspect the Execution before retrying.

For local commands, see `datacenter.env.example`. Export values in the shell;
the script does not automatically load environment files.
