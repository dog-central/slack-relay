# Slack relay

This repository sends Slack messages for the private stocker production workflows. The caller sends only GitHub run and artifact IDs in the dispatch. Message content is downloaded from the private repository and sent directly to Slack. This public repository retains a short-lived encrypted acknowledgement for each message, with the key held in the private caller's session artifact. The worker suppresses its standard output and error streams. GitHub still records run status and step metadata.

Configure the GitHub App Client ID as APP_CLIENT_ID (Actions variable or secret) and its PEM as APP_PRIVATE_KEY (Actions secret). The app must be installed on powerpower2005/stocker with Actions read access for this workflow. Allow the same app to dispatch this repository's workflow with Actions write access.

Set these Actions secrets for the approved Slack destinations.

- SLACK_BOT_TOKEN
- SLACK_SECTOR_CHANNEL_ID
- SLACK_LOG_CHANNEL_ID
- SLACK_ERROR_CHANNEL_ID
- SLACK_CHART_SIGNAL_CHANNEL_ID

Set the SLACK_RELAY_RUNNER Actions variable to an available runner label if this repository uses a designated runner. The default is GitHub-hosted Ubuntu.

To check configuration, manually run Slack relay on main with both inputs blank. That verifies the app's source access, configured channel ID formats and Slack authentication. It sends no message. Use a separately authorized dispatch from stocker to verify actual posting and threaded receipts.
