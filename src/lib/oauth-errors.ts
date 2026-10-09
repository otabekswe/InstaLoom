export const oauthErrors: Record<string, string> = {
  not_owner: "This workspace is private. Sign in with its configured Instagram owner account.",
  configuration_required: "This workspace’s Instagram login setup is incomplete. Check the app credentials and application origin.",
  owner_not_configured: "This private workspace is not configured yet. Set OWNER_INSTAGRAM_ID before connecting Instagram.",
  auth_cancelled: "Instagram authorization was cancelled. You can try again when you’re ready.",
  missing_code: "Instagram did not complete authorization. Please try again.",
  invalid_state: "The connection expired or belongs to another browser. Continue with Instagram again.",
  account_mismatch: "This Instagram account already belongs to another workspace. Sign out to open that workspace.",
  missing_permissions: "Allow Instagram profile, message, and comment access to connect your inbox.",
  connection_failed: "The account could not be connected. Check the Meta app’s permissions and try again.",
  auth_failed: "Instagram couldn’t be connected. Use a Business or Creator account and check your Instagram business login settings.",
};
