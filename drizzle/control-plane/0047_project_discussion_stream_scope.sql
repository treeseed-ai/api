-- A discussion belongs to its project library; a portfolio topic has one stream per project.
ALTER TABLE "communication_discussion_streams" DROP CONSTRAINT "communication_discussion_streams_discussion_unique";
ALTER TABLE "communication_discussion_streams" ADD CONSTRAINT "communication_discussion_streams_project_discussion_unique" UNIQUE("project_id", "discussion_id");
