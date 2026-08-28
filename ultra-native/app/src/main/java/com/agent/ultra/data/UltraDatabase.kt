package com.agent.ultra.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [ConversationEntity::class, MessageEntity::class,
        TaskShortcutEntity::class, ToolReliabilityEntity::class],
    version = 2,
)
abstract class UltraDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun taskMemory(): TaskMemoryDao

    companion object {
        @Volatile private var instance: UltraDatabase? = null

        fun get(context: Context): UltraDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, UltraDatabase::class.java, "ultra.db"
            ).fallbackToDestructiveMigration()  // dev-stage schema evolution
            .build().also { instance = it }
        }
    }
}
