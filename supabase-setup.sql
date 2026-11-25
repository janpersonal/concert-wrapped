-- Run this once in your Supabase project: SQL Editor > New query > paste > Run.
-- It creates one private row of data per user. Nobody else can read yours.

create table if not exists shows_data (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

alter table shows_data enable row level security;

create policy "own row only" on shows_data
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Tip: for a personal app, go to Authentication > Providers > Email and turn off
-- "Confirm email" so you can sign in right after creating your account.
