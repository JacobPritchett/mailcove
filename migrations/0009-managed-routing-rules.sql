-- Registry of Email Routing rules this inbox created, keyed by (zone, rule id).
-- Ownership source of truth for toggling/deleting a rule: a rule recorded here
-- is unambiguously ours, so an enumerated rule id can't be used to mutate or
-- delete a rule we didn't create. The `rule:` name marker (see createRule)
-- remains a fallback for rules created before this table existed — see
-- isOwnedRule in src/cf_routing.ts. createRule inserts; deleteRule removes.
CREATE TABLE IF NOT EXISTS managed_routing_rules (
  zone_id  TEXT NOT NULL,
  rule_id  TEXT NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (zone_id, rule_id)
);
