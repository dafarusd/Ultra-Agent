package com.agent.ultra.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [ConversationEntity::class, MessageEntity::class], version = 1)
abstract class UltraDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao

    companion object {
        @Volatile private var instance: UltraDatabase? = null

        fun get(context: Context): UltraDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, UltraDatabase::class.java, "ultra.db"
            ).build().also { instance = it }
        }
    }
}
