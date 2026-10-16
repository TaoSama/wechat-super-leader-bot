-- Read-only operational snapshot. Does not print prompts, credentials or message bodies.
\pset pager off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT CURRENT_TIMESTAMP AS audited_at;
SELECT name,to_regclass('public.' || name) IS NOT NULL AS exists
FROM unnest(ARRAY['commands','messages','leader_states','leader_executions','leader_notifications','leader_goals']) AS t(name);
SELECT status,count(*) FROM commands GROUP BY status ORDER BY status;
SELECT command_id,node_id,session_id,action,status,turn_id,expires_at,updated_at
FROM commands WHERE status NOT IN ('completed','failed','input-written') ORDER BY command_id;
SELECT md5(chat_id) AS chat_hash,revision,
 data ? 'inflight' AS has_claim,
 data ? 'pending' AS has_pending_plan,
 data ? 'pendingGoal' AS has_pending_goal,
 jsonb_typeof(data) IS DISTINCT FROM 'object' AS malformed
FROM leader_states ORDER BY chat_id;
SELECT $q$
SELECT id,status,revision,
 jsonb_typeof(data) IS DISTINCT FROM 'object' OR data->>'status' IS DISTINCT FROM status OR data->>'id' IS DISTINCT FROM id AS malformed,
 data->>'expiresAt' AS expires_ms
FROM leader_executions ORDER BY id
$q$ WHERE to_regclass('public.leader_executions') IS NOT NULL
\gexec
SELECT $q$
SELECT id,status,revision,
 jsonb_typeof(data) IS DISTINCT FROM 'object' OR data->>'status' IS DISTINCT FROM status OR data->>'id' IS DISTINCT FROM id AS malformed,
 data ? 'lease' AS has_decision_lease,
 CASE WHEN jsonb_typeof(data->'actions')='array' THEN jsonb_array_length(data->'actions') END AS action_count,
 data->>'decisionAttempts' AS decision_attempts,data->>'expiresAt' AS expires_ms
FROM leader_goals ORDER BY id
$q$ WHERE to_regclass('public.leader_goals') IS NOT NULL
\gexec
SELECT $q$
SELECT id,status,expires_at,data->>'attemptId' AS attempt_id,
 CASE WHEN status='uncertain' THEN 'uncertain-do-not-resend' WHEN status='claimed' THEN 'claimed-needs-review'
 WHEN status='accepted' THEN 'accepted-not-human-delivery' ELSE 'pending-needs-review' END AS disposition,
 jsonb_typeof(data) IS DISTINCT FROM 'object' OR data->>'id' IS DISTINCT FROM id OR data->>'status' IS DISTINCT FROM status AS malformed
FROM leader_notifications ORDER BY id
$q$ WHERE to_regclass('public.leader_notifications') IS NOT NULL
\gexec
SELECT 'commands' AS table_name,count(*) AS rows,md5(coalesce(string_agg(md5((to_jsonb(c)-'input_receipt')::text),'' ORDER BY command_id),'')) AS digest FROM commands c;
SELECT 'messages' AS table_name,count(*) AS rows,md5(coalesce(string_agg(md5(to_jsonb(m)::text),'' ORDER BY chat_id,message_id),'')) AS digest FROM messages m;
SELECT 'leader_states' AS table_name,count(*) AS rows,md5(coalesce(string_agg(md5(to_jsonb(s)::text),'' ORDER BY chat_id),'')) AS digest FROM leader_states s;
SELECT format('SELECT %L AS table_name,count(*) AS rows,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY id),'''')) AS digest FROM %I t',name,name)
FROM unnest(ARRAY['leader_executions','leader_notifications','leader_goals']) t(name) WHERE to_regclass('public.' || name) IS NOT NULL
\gexec
COMMIT;
