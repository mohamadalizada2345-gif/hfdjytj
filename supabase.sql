create extension if not exists pgcrypto;

create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    tx_hash text not null unique,
    amount numeric(20, 0) not null,
    wallet text not null,
    status text not null default 'verified'
        check (status in ('verified')),
    created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
    user_id uuid primary key references auth.users(id) on delete cascade,
    plan text not null default 'premium',
    starts_at timestamptz not null default now(),
    expires_at timestamptz not null,
    updated_at timestamptz not null default now()
);

alter table public.payments enable row level security;
alter table public.subscriptions enable row level security;

drop policy if exists "Users can view their own payments"
on public.payments;

create policy "Users can view their own payments"
on public.payments
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can view their own subscription"
on public.subscriptions;

create policy "Users can view their own subscription"
on public.subscriptions
for select
to authenticated
using (auth.uid() = user_id);

create or replace function public.activate_maz_subscription(
    p_user_id uuid,
    p_tx_hash text,
    p_amount numeric,
    p_wallet text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_existing_user uuid;
    v_expiry timestamptz;
    v_now timestamptz := now();
begin
    if p_amount <> 20000000 then
        raise exception 'Invalid payment amount';
    end if;

    if p_tx_hash !~ '^0x[a-f0-9]{64}$' then
        raise exception 'Invalid transaction hash';
    end if;

    if p_wallet <> lower(
        '0x66cB4bbbCb37A9f7Ecb48d5EFFc52708a8b9C791'
    ) then
        raise exception 'Invalid payment wallet';
    end if;

    select user_id into v_existing_user
    from public.payments
    where tx_hash = p_tx_hash;

    if found then
        raise exception 'Transaction hash has already been used';
    end if;

    insert into public.payments (
        user_id,
        tx_hash,
        amount,
        wallet,
        status
    )
    values (
        p_user_id,
        p_tx_hash,
        p_amount,
        p_wallet,
        'verified'
    );

    select expires_at into v_expiry
    from public.subscriptions
    where user_id = p_user_id
    for update;

    if found and v_expiry > v_now then
        v_expiry := v_expiry + interval '30 days';
    else
        v_expiry := v_now + interval '30 days';
    end if;

    insert into public.subscriptions (
        user_id,
        plan,
        starts_at,
        expires_at,
        updated_at
    )
    values (
        p_user_id,
        'premium',
        v_now,
        v_expiry,
        v_now
    )
    on conflict (user_id)
    do update set
        plan = 'premium',
        expires_at = excluded.expires_at,
        updated_at = v_now;

    return jsonb_build_object(
        'plan', 'premium',
        'expires_at', v_expiry
    );
end;
$$;

revoke all on function public.activate_maz_subscription(
    uuid, text, numeric, text
) from public, anon, authenticated;

grant execute on function public.activate_maz_subscription(
    uuid, text, numeric, text
) to service_role;