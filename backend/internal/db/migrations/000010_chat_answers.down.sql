DROP INDEX chat_messages_streaming_idx;
ALTER TABLE chat_messages DROP COLUMN error_message;
ALTER TABLE chat_messages DROP COLUMN status;
