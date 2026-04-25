-- Run this in Supabase SQL Editor after your main schema migration.
-- This enables safe browser access with the publishable key.

alter table public.users enable row level security;
alter table public.user_profiles enable row level security;
alter table public.reports enable row level security;
alter table public.report_items enable row level security;
alter table public.report_summaries enable row level security;
alter table public.daily_summaries enable row level security;

-- USERS
create policy if not exists "users_select_own"
on public.users
for select
 to authenticated
using (supabase_auth_id = auth.uid());

create policy if not exists "users_insert_own"
on public.users
for insert
 to authenticated
with check (supabase_auth_id = auth.uid());

create policy if not exists "users_update_own"
on public.users
for update
 to authenticated
using (supabase_auth_id = auth.uid())
with check (supabase_auth_id = auth.uid());

-- USER PROFILES
create policy if not exists "profiles_select_own"
on public.user_profiles
for select
 to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.id = user_profiles.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "profiles_insert_own"
on public.user_profiles
for insert
 to authenticated
with check (
  exists (
    select 1
    from public.users u
    where u.id = user_profiles.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "profiles_update_own"
on public.user_profiles
for update
 to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.id = user_profiles.user_id
      and u.supabase_auth_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.users u
    where u.id = user_profiles.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

-- REPORTS
create policy if not exists "reports_select_own"
on public.reports
for select
 to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.id = reports.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "reports_insert_own"
on public.reports
for insert
 to authenticated
with check (
  exists (
    select 1
    from public.users u
    where u.id = reports.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "reports_update_own"
on public.reports
for update
 to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.id = reports.user_id
      and u.supabase_auth_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.users u
    where u.id = reports.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

-- REPORT ITEMS
create policy if not exists "report_items_select_own"
on public.report_items
for select
 to authenticated
using (
  exists (
    select 1
    from public.reports r
    join public.users u on u.id = r.user_id
    where r.id = report_items.report_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "report_items_insert_own"
on public.report_items
for insert
 to authenticated
with check (
  exists (
    select 1
    from public.reports r
    join public.users u on u.id = r.user_id
    where r.id = report_items.report_id
      and u.supabase_auth_id = auth.uid()
  )
);

-- REPORT SUMMARIES
create policy if not exists "report_summaries_select_own"
on public.report_summaries
for select
 to authenticated
using (
  exists (
    select 1
    from public.reports r
    join public.users u on u.id = r.user_id
    where r.id = report_summaries.report_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "report_summaries_insert_own"
on public.report_summaries
for insert
 to authenticated
with check (
  exists (
    select 1
    from public.reports r
    join public.users u on u.id = r.user_id
    where r.id = report_summaries.report_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "report_summaries_update_own"
on public.report_summaries
for update
 to authenticated
using (
  exists (
    select 1
    from public.reports r
    join public.users u on u.id = r.user_id
    where r.id = report_summaries.report_id
      and u.supabase_auth_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.reports r
    join public.users u on u.id = r.user_id
    where r.id = report_summaries.report_id
      and u.supabase_auth_id = auth.uid()
  )
);

-- DAILY SUMMARIES
create policy if not exists "daily_summaries_select_own"
on public.daily_summaries
for select
 to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.id = daily_summaries.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "daily_summaries_insert_own"
on public.daily_summaries
for insert
 to authenticated
with check (
  exists (
    select 1
    from public.users u
    where u.id = daily_summaries.user_id
      and u.supabase_auth_id = auth.uid()
  )
);

create policy if not exists "daily_summaries_update_own"
on public.daily_summaries
for update
 to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.id = daily_summaries.user_id
      and u.supabase_auth_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.users u
    where u.id = daily_summaries.user_id
      and u.supabase_auth_id = auth.uid()
  )
);
