/**
 * Which secret controls to offer, matching what the server accepts: changes are superadmin-only,
 * a value can be rotated only where the Worker's secrets are manageable, and a name can be
 * removed only while it has no value.
 */
export function secretActions(role: "superadmin" | "admin", secret: { set: boolean }, manageable: boolean): { rotate: boolean; remove: boolean } {
  const edit = role === "superadmin";
  return { rotate: edit && manageable && secret.set, remove: edit && !secret.set };
}
