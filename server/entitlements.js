export const PRODUCT_SLUGS = ['opsp', 'opsfinance', 'opsflow', 'opswms', 'opshr'];

const SLUG = /^[a-z0-9_]{1,32}$/;

export const hasLifetime = (userId, lifetime = []) =>
  lifetime.some((row) => row.user_id === userId && row.status === 'active' && row.scope === 'all_apps');

export function resolveProductStates({ userId, catalog, subscriptions, grants, lifetime = [], now }) {
  const entitled = new Set();
  const live = new Set(catalog.filter((item) => item.launch_status === 'live' && SLUG.test(item.slug)).map((item) => item.slug));
  if (hasLifetime(userId, lifetime)) live.forEach((slug) => entitled.add(slug));
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    if (sub.current_period_end && !(Date.parse(sub.current_period_end) > now)) continue;
    if (sub.personal_user_id) {
      if (sub.personal_user_id !== userId) continue;
      if (sub.is_complete_bundle) live.forEach((slug) => entitled.add(slug));
      else if (sub.product_slug) entitled.add(sub.product_slug);
    } else if (sub.organization_id) {
      for (const grant of grants) {
        if (grant.organization_id === sub.organization_id && (sub.is_complete_bundle || grant.product_slug === sub.product_slug)) {
          entitled.add(grant.product_slug);
        }
      }
    }
  }
  const slugs = [...new Set([...PRODUCT_SLUGS, ...catalog.map((item) => item.slug).filter((slug) => SLUG.test(slug))])];
  return Object.fromEntries(slugs.map((slug) => [
    slug,
    !live.has(slug) ? 'coming_soon' : entitled.has(slug) ? 'active' : 'none',
  ]));
}
