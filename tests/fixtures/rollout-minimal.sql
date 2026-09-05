CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA tender;
CREATE SCHEMA saas;
CREATE SCHEMA iam;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tender_api_runtime') THEN
    CREATE ROLE tender_api_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wb_tender_api_login') THEN
    CREATE ROLE wb_tender_api_login LOGIN IN ROLE tender_api_runtime;
  END IF;
END $$;
GRANT USAGE ON SCHEMA iam TO tender_api_runtime;
CREATE TABLE tender.autopilot_results(tender_id uuid,company_id uuid,lot_key text,result_version integer);
CREATE TABLE tender.autopilot_queue(tender_id uuid,company_id uuid,lot_key text,created_at timestamptz,action_type text);
CREATE TABLE tender.enrichment_versions(tender_id uuid,version integer,historical boolean);
CREATE TABLE saas.plans(
  code text PRIMARY KEY,
  display_name text NOT NULL,
  description text NOT NULL,
  seat_limit integer,
  company_limit integer,
  recommended_monthly_price_minor bigint,
  price_status text NOT NULL,
  active boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT '2026-09-04T00:00:00Z'
);
INSERT INTO saas.plans(code,display_name,description,seat_limit,company_limit,recommended_monthly_price_minor,price_status,active) VALUES
('CORE','Previous Core','Synthetic pre-rollout row',1,1,100,'PLACEHOLDER',true),
('NORMAL','Previous Normal','Synthetic pre-rollout row',1,1,200,'PLACEHOLDER',false),
('PROFESSIONAL','Previous Professional','Synthetic pre-rollout row',1,1,300,'PLACEHOLDER',false),
('ENTERPRISE','Previous Enterprise','Synthetic pre-rollout row',1,1,400,'PLACEHOLDER',false);
CREATE TABLE iam.users(id uuid PRIMARY KEY);
INSERT INTO iam.users(id) VALUES ('00000000-0000-0000-0000-000000000001');
