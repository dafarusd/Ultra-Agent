package com.agent.ultra.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [ConversationEntity::class, MessageEntity::class,
        TaskShortcutEntity::class, ToolReliabilityEntity::class,
        RecipeEntity::class, ScreenMemoryEntity::class],
    version = 6,
)
abstract class UltraDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun taskMemory(): TaskMemoryDao
    abstract fun recipes(): RecipeDao
    abstract fun screenMemory(): ScreenMemoryDao

    companion object {
        @Volatile private var instance: UltraDatabase? = null

        /** v2 → v3 adds the recipes table. Written as a real migration rather
         * than a destructive fallback: conversations and task memory are the
         * user's data now, not dev scratch. */
        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `recipes` (" +
                        "`name` TEXT NOT NULL, " +
                        "`stepsJson` TEXT NOT NULL, " +
                        "`createdAt` INTEGER NOT NULL, " +
                        "`lastRun` INTEGER NOT NULL, " +
                        "`runCount` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`name`))"
                )
            }
        }

        /** v3 → v4 records the full calls, not just the tool names. */
        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `task_shortcuts` ADD COLUMN `stepsJson` TEXT NOT NULL DEFAULT ''")
            }
        }

        /** v4 → v5 adds what the agent has learned about each screen. Structure
         * only: no text from any screen is stored here. */
        private val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `screen_memory` (" +
                        "`screenKey` TEXT NOT NULL, " +
                        "`pkg` TEXT NOT NULL, " +
                        "`template` TEXT NOT NULL, " +
                        "`recordCount` INTEGER NOT NULL, " +
                        "`fieldsCsv` TEXT NOT NULL, " +
                        "`seenCount` INTEGER NOT NULL, " +
                        "`lastSeen` INTEGER NOT NULL, " +
                        "`confidence` TEXT NOT NULL, " +
                        "PRIMARY KEY(`screenKey`))"
                )
            }
        }

        /** v5 → v6 remembers where a screen's controls are. Ids and roles
         * only — no label and no value is written here. */
        private val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `screen_memory` ADD COLUMN `controlsJson` TEXT NOT NULL DEFAULT ''")
            }
        }

        fun get(context: Context): UltraDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, UltraDatabase::class.java, "ultra.db"
            ).addMigrations(MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6)
            .fallbackToDestructiveMigration()  // last resort for older dev schemas
            .build().also { instance = it }
        }
    }
}
