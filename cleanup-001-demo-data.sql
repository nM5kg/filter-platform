-- Filter Platform — cleanup 001: remove ALL demo/placeholder rows created
-- during the first smoke test (Demo Family, demo devices, demo request,
-- audit rows), then re-seed the real global lists from seed.sql.
-- Keeps: the Standard policy + its v1 snapshot.
DELETE FROM device_status;
DELETE FROM audit_logs;
DELETE FROM approval_requests;
DELETE FROM devices;
DELETE FROM customers;
DELETE FROM users;
DELETE FROM domains;
DELETE FROM applications;
DELETE FROM blocked_words;
DELETE FROM ai_analysis_results;
