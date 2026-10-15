package app.route3d;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // An app-local plugin is not discovered the way an installed one is;
        // it has to be named before the bridge is built.
        registerPlugin(RecordingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
