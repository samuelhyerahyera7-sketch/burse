-- ============================================================
-- RENT AND BUY — Property Portal Schema
-- Run in Supabase → SQL Editor
-- ============================================================

-- ── Properties table (live listings) ────────────────────────
create table if not exists public.properties (
  id            bigserial primary key,
  mode          text not null,        -- buy | rent | new | sold | commercial | farm | auction
  type          text,                 -- House | Apartment | Townhouse | Plot | Farm | Office | Retail | Warehouse
  price         numeric(14,2) not null,
  beds          int default 0,
  baths         int default 0,
  garages       int default 0,
  size          int default 0,        -- m²
  erf           int,                  -- erf size m²
  title         text not null,
  suburb        text,
  city          text,
  province      text,
  description   text,
  featured      boolean default false,
  lat           numeric(10,6),        -- for map markers
  lng           numeric(10,6),
  agent_name    text,
  agent_agency  text,
  agent_init    text,
  agent_phone   text,
  agent_email   text,
  imgs          text[] default '{}',  -- array of image URLs
  sold_date     date,
  auction_date  date,
  status        text default 'active', -- active | pending | sold | let
  created_at    timestamptz default now()
);

-- ── Pending listing submissions from the "List Property" form ──
create table if not exists public.property_listings (
  id            bigserial primary key,
  agent_name    text,
  agent_phone   text,
  agent_email   text,
  mode          text,
  type          text,
  price         numeric(14,2),
  address       text,
  description   text,
  status        text default 'pending', -- pending | approved | rejected
  created_at    timestamptz default now()
);

-- ── Row Level Security ───────────────────────────────────────
alter table public.properties enable row level security;
alter table public.property_listings enable row level security;

-- Anyone can read active properties
create policy "Public read properties"
  on public.properties for select
  using (status = 'active');

-- Authenticated users can insert their own listings
create policy "Auth users can list properties"
  on public.properties for insert
  to authenticated
  with check (true);

-- Anyone can submit a listing inquiry
create policy "Anyone can submit listing"
  on public.property_listings for insert
  with check (true);

-- ── Sample data ───────────────────────────────────────────────
-- Uncomment to seed a test property:
-- insert into public.properties (mode,type,price,beds,baths,garages,size,erf,title,suburb,city,province,description,featured,lat,lng,agent_name,agent_agency,agent_init)
-- values ('buy','House',3500000,4,3,2,280,650,'Sunny family home with pool','Bryanston','Johannesburg','Gauteng','Spacious north-facing home in sought-after Bryanston.',true,-26.0592,28.0216,'Jane Smith','Rent and Buy','JS');
