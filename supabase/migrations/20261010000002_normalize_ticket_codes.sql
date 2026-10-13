-- Accept codes typed loosely at the door: "tst 5lsl fzyt", "5LSLFZYT", "TST-5LSL-FZYT".
create or replace function public.normalize_ticket_code(p_code text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when length(r) = 11 and left(r, 3) = 'TST' then 'TST-' || substr(r, 4, 4) || '-' || substr(r, 8, 4)
    when length(r) = 8 then 'TST-' || substr(r, 1, 4) || '-' || substr(r, 5, 4)
    else r
  end
  from (select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) as r) x;
$$;

create or replace function public.check_in(p_code text, p_undo boolean default false)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v record;
  v_code text := public.normalize_ticket_code(p_code);
begin
  select t.id, t.code, t.holder_name, t.label, t.voided, t.checked_in_at,
         o.status as order_status, o.buyer_email, tt.name as ticket_type,
         s.starts_at, s.title
    into v
    from public.tickets t
    join public.orders o on o.id = t.order_id
    join public.ticket_types tt on tt.id = t.ticket_type_id
    join public.shows s on s.id = t.show_id
   where t.code = v_code
   for update of t;

  if not found then
    return jsonb_build_object('result', 'not_found', 'code', v_code);
  end if;

  if v.voided or v.order_status not in ('paid', 'comp') then
    return jsonb_build_object('result', 'invalid', 'code', v.code, 'holder_name', v.holder_name,
                              'label', v.label, 'reason', case when v.voided then 'voided' else v.order_status end);
  end if;

  if p_undo then
    update public.tickets set checked_in_at = null where id = v.id;
    return jsonb_build_object('result', 'undone', 'code', v.code, 'holder_name', v.holder_name, 'label', v.label);
  end if;

  if v.checked_in_at is not null then
    return jsonb_build_object('result', 'already_used', 'code', v.code, 'holder_name', v.holder_name,
                              'label', v.label, 'ticket_type', v.ticket_type, 'checked_in_at', v.checked_in_at,
                              'show_starts_at', v.starts_at);
  end if;

  update public.tickets set checked_in_at = now() where id = v.id;
  return jsonb_build_object('result', 'ok', 'code', v.code, 'holder_name', v.holder_name, 'label', v.label,
                            'ticket_type', v.ticket_type, 'show_starts_at', v.starts_at);
end;
$$;

revoke execute on function public.check_in(text, boolean) from public, anon, authenticated;
