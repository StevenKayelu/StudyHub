-- StudyHub database roles (blueprint 04 §17.4, 10 §6).
-- Runs once, as the postgres superuser, when the data volume is first initialised
-- (docker-entrypoint-initdb.d), connected to $POSTGRES_DB. Passwords come from the
-- environment via psql \getenv and are never written to this file.
--
--   studyhub_migrator  owns the database and the public schema; runs migrations only.
--   studyhub_app       used by the API and worker at runtime; data access (DML) only, no DDL.
--
-- The third role (studyhub_platform, BYPASSRLS) is introduced in M2 with the tenancy kernel.

\set ON_ERROR_STOP on

\getenv migrator_password STUDYHUB_MIGRATOR_PASSWORD
\getenv app_password STUDYHUB_APP_PASSWORD
\getenv database_name POSTGRES_DB

CREATE ROLE studyhub_migrator LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

CREATE ROLE studyhub_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

ALTER DATABASE :"database_name" OWNER TO studyhub_migrator;
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO studyhub_app;

-- Only the migrator may create objects; the app role may use the schema but never alter it.
ALTER SCHEMA public OWNER TO studyhub_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO studyhub_app;

-- Objects created later by the migrator are usable (DML only) by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE studyhub_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studyhub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE studyhub_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO studyhub_app;
