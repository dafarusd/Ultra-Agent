import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

/**
 * The release signing key, or null when this machine does not have it.
 *
 * A build without the key still works and is signed with the debug key; it is
 * simply not something to publish. Gradle would otherwise fail on every clone
 * that has no business holding the secret.
 */
val releaseKeystore: Properties? =
    // rootProject, not the app module: file() here would look inside app/.
    rootProject.file("keystore.properties").takeIf { it.exists() }?.let { f ->
        Properties().apply { f.inputStream().use { load(it) } }
    }

android {
    testOptions {
        // ScreenStructure logs which method chose the records, which is the
        // only way to tell on a device whether the template match or the
        // fallback ran. android.util.Log throws in a JVM unit test unless
        // stubs return defaults.
        unitTests.isReturnDefaultValues = true
    }

    namespace = "com.agent.ultra"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.agent.ultra"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "2.1.2-native"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    signingConfigs {
        // Same keystore the Expo builds used (android/app/debug.keystore, copied
        // here) — install-over continuity on devices carrying a Build 29/30 install.
        create("legacyDebug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }

        // The real signing key, for anything that leaves this machine.
        //
        // 2.0.0 and 2.1.0 went out signed with the DEBUG key, whose password is
        // "android" and which ships inside the Android SDK. Anyone at all can
        // sign an APK with it, and Android would accept that stranger's build
        // as a legitimate update to this app, installing straight over it.
        //
        // keystore.properties is gitignored and holds the only copy of the
        // password. When it is absent — a fresh clone, or anyone else's machine
        // — the build falls back to the debug key rather than failing, because
        // a local build is not a release and should not need the secret.
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore!!.getProperty("storeFile"))
                storePassword = releaseKeystore!!.getProperty("storePassword")
                keyAlias = releaseKeystore!!.getProperty("keyAlias")
                keyPassword = releaseKeystore!!.getProperty("keyPassword")
                // v3 carries a proof-of-rotation record, so this key can be
                // replaced later without every install having to be removed.
                // If this key is ever exposed, that is the difference between
                // an update and starting again. v1 is off: it is only needed
                // below API 24 and minSdk here is 26.
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("legacyDebug")
        }
        release {
            signingConfig = signingConfigs.getByName(
                if (releaseKeystore != null) "release" else "legacyDebug"
            )
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.28.3"
        }
    }
    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    // org.json on the JVM test classpath (Android ships it; unit tests need it)
    testImplementation("org.json:json:20240303")
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.ui.test.junit4)
    debugImplementation(libs.androidx.ui.tooling)
    debugImplementation(libs.androidx.ui.test.manifest)
}
