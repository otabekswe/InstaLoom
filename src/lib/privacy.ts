/** These operator-supplied values are deliberately public on the policy pages. */
export function getPrivacyContact() {
  const name = process.env.PRIVACY_CONTACT_NAME?.trim() || "the operator of this InstaLoom workspace";
  const candidateEmail = process.env.PRIVACY_CONTACT_EMAIL?.trim();
  const email = candidateEmail && /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(candidateEmail) ? candidateEmail : null;
  let url: string | null = null;
  try {
    const candidate = new URL(process.env.PRIVACY_CONTACT_URL || "");
    if (candidate.protocol === "https:" && !candidate.username && !candidate.password) url = candidate.href;
  } catch { /* An operator can provide an email instead. */ }
  return { name, email, url, configured: Boolean(email || url) };
}
