# Jira Cloud Automation rule

Prerequisites: Xray Cloud is installed, Test Plan and Test Execution issue types
are enabled in the project, and the Test Plan workflow includes an **Execute**
status. Populate the Plan with automated Generic Tests. Allow `api.github.com`
in any Automation outbound-domain restrictions.

1. Open **Project settings > Automation > Create rule** (some Jira sites use
   “Space” or “Work item” labels).
2. Add **Issue transitioned**, with **To status: Execute**.
3. Add an **Issue fields condition**, **Issue Type equals Test Plan**. The type
   condition is separate from the transition trigger in the rule editor.
4. Add **Create issue**:
   - Project: the triggering issue's project.
   - Issue type: **Test Execution**.
   - Summary: `Automated execution of {{issue.key}} - {{now}}`.
   - Description: `Playwright execution for Test Plan {{issue.key}}`.
   - Supply any other required fields from your project's create screen.
   - In additional fields, configure a standard Jira relationship to the trigger
     (use an enabled link type; this example uses the default `Relates`):

   ```json
   {
     "update": {
       "issuelinks": [{
         "add": {
           "type": { "name": "Relates" },
           "outwardIssue": { "key": "{{issue.key}}" }
         }
       }]
     }
   }
   ```

   If your Create issue action cannot set links through additional fields, add a
   **Link issues** action after creation, linking the triggering issue to
   `{{createdIssue.key}}` with “relates to”. Both approaches require Link Issues.

5. Add **Send web request** immediately after creation/linking, in the original
   trigger context. Do not branch to the new issue: `{{issue.key}}` must still
   reference the Test Plan and `{{createdIssue.key}}` the new Execution.

   **Method:** `POST`

   **URL:** `https://api.github.com/repos/{owner}/playwright-ci-runner/dispatches`

   Replace `{owner}` and the repository name with your actual values.

   | Header | Value |
   | --- | --- |
   | Accept | `application/vnd.github+json` |
   | Authorization | `Bearer YOUR_GITHUB_DISPATCH_PAT` |
   | Content-Type | `application/json` |
   | X-GitHub-Api-Version | `2022-11-28` |

   Mark **Authorization** as hidden/secret in Automation. Store the token there;
   do not put it in a Jira issue, smart-value variable, source file or audit log.
   Choose **Custom data** as the request body:

   ```json
   {
     "event_type": "execute-xray-tests",
     "client_payload": {
       "testPlanKey": "{{issue.key}}",
       "testExecKey": "{{createdIssue.key}}"
     }
   }
   ```

6. Enable waiting for the response, if available. Successful dispatch is HTTP
   **204**, with no response body. Inspect the Automation audit log for failure.
   Acceptance means GitHub received the event; it does not mean the tests passed.
7. Save and enable the rule. Transition a small reference Plan to Execute and
   follow the corresponding run in the runner repository's Actions tab.

The Jira relationship above provides navigation. The runner additionally calls
Xray's `addTestExecutionsToTestPlan` with numeric issue IDs, establishing the actual
Xray association. A generic Jira link alone does not establish Plan membership.
No site-specific Xray custom field ID is assumed. See the
[Xray association API](https://us.xray.cloud.getxray.app/doc/graphql/addtestexecutionstotestplan.doc.html).

The rule actor needs Browse Projects, Create Issues and Link Issues in the target
project, access through issue security, and the required fields supplied. Users
who trigger the rule need the workflow transition permission. Xray API permissions
belong to the Xray API-key user, not automatically the Automation actor.

Create exactly one Execution before this request; later Create issue actions would
change `createdIssue`. Do not configure the rule to loop on its own updates. Repeated
transitions create new Executions. If Xray has not yet indexed a fresh Execution,
wait and manually rerun the existing GitHub workflow with the same keys.

References: [Atlassian Automation actions](https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/),
[GitHub repository dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
