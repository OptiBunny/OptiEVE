import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
export const eveSettings=sqliteTable("eve_settings",{userId:text("user_id").primaryKey(),clientId:text("client_id").notNull()});
export const eveOauthStates=sqliteTable("eve_oauth_states",{stateHash:text("state_hash").primaryKey(),userId:text("user_id").notNull(),encrypted:text("encrypted").notNull(),expires:integer("expires").notNull()});
export const eveConnections=sqliteTable("eve_connections",{
 userId:text("user_id").notNull(),characterId:integer("character_id").notNull(),name:text("name").notNull(),corporationId:integer("corporation_id").notNull(),scopes:text("scopes").notNull(),encrypted:text("encrypted").notNull(),expires:integer("expires").notNull(),refreshLock:text("refresh_lock"),refreshUntil:integer("refresh_until")
},table=>[primaryKey({columns:[table.userId,table.characterId]})]);
