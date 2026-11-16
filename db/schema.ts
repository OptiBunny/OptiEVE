import { sqliteTable, text, integer, primaryKey, foreignKey } from "drizzle-orm/sqlite-core";
export const eveSettings=sqliteTable("eve_settings",{userId:text("user_id").primaryKey(),clientId:text("client_id").notNull()});
export const eveOauthStates=sqliteTable("eve_oauth_states",{stateHash:text("state_hash").primaryKey(),userId:text("user_id").notNull(),encrypted:text("encrypted").notNull(),expires:integer("expires").notNull()});
export const eveConnections=sqliteTable("eve_connections",{
 userId:text("user_id").notNull(),characterId:integer("character_id").notNull(),name:text("name").notNull(),corporationId:integer("corporation_id").notNull(),scopes:text("scopes").notNull(),encrypted:text("encrypted").notNull(),expires:integer("expires").notNull(),refreshLock:text("refresh_lock"),refreshUntil:integer("refresh_until"),historyEpoch:text("history_epoch").notNull().default("")
},table=>[primaryKey({columns:[table.userId,table.characterId]})]);
export const eveWalletHistory=sqliteTable("eve_wallet_history",{
 userId:text("user_id").notNull(),characterId:integer("character_id").notNull(),generation:text("generation").notNull(),enabled:integer("enabled").notNull(),retentionDays:integer("retention_days").notNull(),encrypted:text("encrypted").notNull()
},table=>[primaryKey({columns:[table.userId,table.characterId]}),foreignKey({columns:[table.userId,table.characterId],foreignColumns:[eveConnections.userId,eveConnections.characterId]}).onDelete("cascade")]);
