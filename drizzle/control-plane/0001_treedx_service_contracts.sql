CREATE TABLE "treedx_service_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"package_version" text NOT NULL,
	"openapi_version" text NOT NULL,
	"openapi_digest" text NOT NULL,
	"operation_inventory_digest" text NOT NULL,
	"generated_types_digest" text NOT NULL,
	"compatibility_status" text NOT NULL,
	"status" text NOT NULL,
	"capability_groups_json" text DEFAULT '[]' NOT NULL,
	"observed_at" text,
	"accepted_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "uq_treedx_service_contracts_connection_digest" UNIQUE("connection_id", "openapi_digest"),
	CONSTRAINT "chk_treedx_service_contracts_status" CHECK ("status" IN ('accepted','verified','incompatible','unavailable'))
);

CREATE INDEX "idx_treedx_service_contracts_connection" ON "treedx_service_contracts" ("connection_id", "updated_at");
