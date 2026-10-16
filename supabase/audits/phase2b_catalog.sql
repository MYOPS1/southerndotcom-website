-- Read-only catalog evidence. Run in the dedicated MYOPS staging project only.
begin read only;
select n.nspname as schema_name, c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname like 'myops\_%' escape '\' and c.relkind = 'r'
order by c.relname;
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' and tablename like 'myops\_%' escape '\'
order by tablename, policyname;
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns where table_schema = 'public' and table_name like 'myops\_%' escape '\'
order by table_name, ordinal_position;
select table_name, grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name like 'myops\_%' escape '\'
order by table_name, grantee, privilege_type;
select p.oid::regprocedure as function_name, p.prosecdef, p.proconfig, p.proacl,
  pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'myops\_%' escape '\';
select event_object_table, trigger_name, action_statement
from information_schema.triggers
where (event_object_schema = 'public' and event_object_table like 'myops\_%' escape '\')
   or (event_object_schema = 'auth' and event_object_table = 'users');
select c.conrelid::regclass as table_name, c.conname, pg_get_constraintdef(c.oid) as definition
from pg_constraint c join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public' and t.relname like 'myops\_%' escape '\';
select slug, display_name, launch_status from public.myops_products order by slug;
rollback;
