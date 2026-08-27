package com.agent.ultra

import android.app.Application

class UltraApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: UltraApplication
            private set
    }
}
