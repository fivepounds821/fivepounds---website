-- Require explicit Sweet Circle opt-in on the order being discounted.
-- A customer's historical stamps remain theirs, but an opted-out order cannot redeem them.
create or replace function public.redeem_fivepounds_reward(p_order_id uuid)
returns table(
  order_id uuid,
  order_number text,
  discount numeric,
  amount_due numeric,
  stamps_balance integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_balance integer;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then raise exception 'Order not found'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order.customer_id::text, 0));

  if v_order.status not in ('pending', 'confirmed') then
    raise exception 'Reward can only be applied before preparation';
  end if;
  if not v_order.rewards_opt_in_at_order then
    raise exception 'Customer must opt in to Sweet Circle for this order';
  end if;
  if v_order.subtotal < 40 then
    raise exception 'RM40 minimum subtotal required';
  end if;
  if v_order.discount > 0 then
    raise exception 'A discount has already been applied';
  end if;

  select coalesce(sum(stamps_delta), 0)::integer into v_balance
  from public.loyalty_transactions
  where customer_id = v_order.customer_id;

  if v_balance < 5 then raise exception 'At least five stamps are required'; end if;

  insert into public.loyalty_transactions (
    customer_id, order_id, transaction_type, stamps_delta, description
  )
  values (
    v_order.customer_id, v_order.id, 'redeemed', -5,
    'RM5 reward redeemed on RM40+ order'
  );

  update public.orders
  set discount = 5, amount_due = subtotal - 5, updated_at = now()
  where id = v_order.id;

  select coalesce(sum(stamps_delta), 0)::integer into v_balance
  from public.loyalty_transactions
  where customer_id = v_order.customer_id;

  return query
  select v_order.id, v_order.order_number, 5::numeric,
         v_order.subtotal - 5, v_balance;
end;
$$;

revoke all on function public.redeem_fivepounds_reward(uuid) from public, anon, authenticated;
grant execute on function public.redeem_fivepounds_reward(uuid) to service_role;
