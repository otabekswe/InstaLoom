export const oauthErrors: Record<string, string> = {
  not_owner: "This workspace is private. Sign in with its configured Instagram owner account.",
  configuration_required: "This workspace’s Instagram login setup is incomplete. Check the app credentials and application origin.",
  owner_not_configured: "The owner restriction is invalid. Set OWNER_INSTAGRAM_ID to a numeric Instagram account ID, or leave it empty to allow Meta-authorized accounts.",
  auth_cancelled: "Instagram authorization was cancelled. You can try again when you’re ready.",
  missing_code: "Instagram did not complete authorization. Please try again.",
  invalid_state: "The connection expired or belongs to another browser. Continue with Instagram again.",
  account_mismatch: "You’re signed in to a different Instagram account. Sign out first to open this account’s separate workspace.",
  missing_permissions: "Allow Instagram profile, message, and comment access to connect your inbox.",
  connection_failed: "The account could not be connected. Check the Meta app’s permissions and try again.",
  auth_failed: "Instagram couldn’t be connected. Use a Business or Creator account and check your Instagram business login settings.",
};
